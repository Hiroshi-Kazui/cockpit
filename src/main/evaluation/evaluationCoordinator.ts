// Orchestrates the M9 purpose-completion evaluation pipeline (ADR-0010): the single place that decides
// what happens when a purpose is completed (D-1) or a user explicitly asks to re-run an evaluation (R-7).
// All actual side effects (DB reads/writes, headless claude execution, report file I/O, pushing updates
// to the renderer) are injected as narrow function-shaped deps -- same dependency-inversion pattern
// purposeCoordinator.ts/mirrorCoordinator.ts use -- so this class is unit-testable without Electron/
// child_process/SQLite/FS.
//
// Fire-and-forget by design (D-1 "完了操作の応答は評価を待たない"): both public entry points
// (triggerForCompletedPurpose / rerun) return immediately; `run` itself is never awaited by a caller.
import {
  buildEvaluationInput,
  buildEvaluationPrompt,
  parseEvaluationResult,
  type EvaluationAppeal,
  type EvaluationAppealPrevious,
  type EvaluationSessionInput
} from '../../shared/evaluation'
import { renderEvaluationReportJson, renderEvaluationReportMarkdown } from '../../shared/evaluationReport'
import type {
  EvaluationInputStats,
  EvaluationReportState,
  EvaluationSuggestion,
  EvaluationSummary
} from '../../shared/ipc'

export interface EvaluationSessionRef {
  id: string
  jsonlPath: string | null
}

export interface InsertEvaluationParams {
  purposeId: string
  createdAt: number
  model: string | null
  inputStats: EvaluationInputStats
  /** M14 (R-7): the appeal this run answers, stored on the brand-new row it creates. Null for an ordinary
   * completion-triggered run. */
  appealText: string | null
}

export interface FinalizeOkParams {
  smoothness: number
  stress: number
  commCost: number
  summary: string
  suggestions: EvaluationSuggestion[]
}

export interface WriteReportResult {
  ok: boolean
  reason?: string
}

export interface EvaluationCoordinatorDeps {
  getEnabled: () => boolean
  getModel: () => string
  getOutputRoot: () => string | null
  getPurposeText: (purposeId: string) => string | null
  getPurposeTitle: (purposeId: string) => string | null
  listSessionsForPurpose: (purposeId: string) => readonly EvaluationSessionRef[]
  /** M14 (R-6): the purpose's current (about-to-be-superseded) evaluation, read *before* this run inserts
   * its own row -- what an appeal is an appeal *against*. Only called when an appeal is present. */
  getPreviousEvaluation: (purposeId: string) => EvaluationAppealPrevious | null
  readSession: (sessionId: string, jsonlPath: string | null) => Promise<EvaluationSessionInput>
  insertPending: (params: InsertEvaluationParams) => EvaluationSummary
  insertSkipped: (params: InsertEvaluationParams) => EvaluationSummary
  finalizeOk: (id: string, params: FinalizeOkParams) => EvaluationSummary | null
  finalizeError: (id: string, lastError: string) => EvaluationSummary | null
  setReportState: (id: string, state: EvaluationReportState) => EvaluationSummary | null
  /** Headless `claude -p --model <model>` one-shot (main/evaluation/evaluationRunner.ts); rejects on any
   * failure (resolution, spawn, timeout). */
  runEvaluation: (prompt: string, model: string) => Promise<string>
  writeReport: (
    root: string,
    evalId: string,
    markdown: string,
    json: string
  ) => Promise<WriteReportResult>
  onEvaluationUpdated: (summary: EvaluationSummary) => void
  now?: () => number
}

export class EvaluationCoordinator {
  private readonly deps: EvaluationCoordinatorDeps

  constructor(deps: EvaluationCoordinatorDeps) {
    this.deps = deps
  }

  /** D-1: called right after PurposeCoordinator.completePurpose succeeds. Fire-and-forget -- never
   * awaited by the caller, so completePurpose's own IPC response is never delayed by this. */
  triggerForCompletedPurpose(purposeId: string): void {
    this.run(purposeId, null).catch((err: unknown) => {
      // Defense-in-depth only: every awaited step inside run() already catches and records its own
      // failure as a visible `error`/`skipped` evaluation row -- this only fires if something outside
      // that (e.g. a deps function itself throwing synchronously) escapes. Never silent (CLAUDE.md).
      console.error(`[evaluation] pipeline failed unexpectedly for purpose ${purposeId}`, err)
    })
  }

  /** R-7: re-runs an evaluation for `purposeId`, always producing a brand-new `evaluations` row
   * (append-only) rather than editing a prior one -- same fire-and-forget contract as the trigger above.
   * M14 (R-5/R-6): `appealText` carries the user's own account of how the previous evaluation missed their
   * experience; it is embedded in the new run's prompt together with the evaluation being disputed. A
   * null/whitespace-only appeal is an ordinary re-run (never recorded as an appeal). */
  rerun(purposeId: string, appealText: string | null = null): void {
    this.run(purposeId, appealText).catch((err: unknown) => {
      console.error(`[evaluation] pipeline failed unexpectedly for purpose ${purposeId}`, err)
    })
  }

  private async run(purposeId: string, appealText: string | null = null): Promise<void> {
    if (!this.deps.getEnabled()) return

    // Read the disputed evaluation *before* this run inserts its own row -- afterwards, "the purpose's
    // latest evaluation" would be this run's own pending row (R-6).
    const trimmedAppeal = appealText === null ? '' : appealText.trim()
    const appeal: EvaluationAppeal | null =
      trimmedAppeal.length === 0
        ? null
        : { text: trimmedAppeal, previous: this.deps.getPreviousEvaluation(purposeId) }

    const model = this.deps.getModel()
    const purposeText = this.deps.getPurposeText(purposeId) ?? ''
    const sessionRefs = this.deps.listSessionsForPurpose(purposeId)

    const sessionInputs: EvaluationSessionInput[] = []
    for (const ref of sessionRefs) {
      sessionInputs.push(await this.deps.readSession(ref.id, ref.jsonlPath))
    }

    const built = buildEvaluationInput(sessionInputs)
    const createdAt = this.deps.now ? this.deps.now() : Date.now()

    if (built.isEmpty) {
      // D-8: no genuine user text anywhere in this purpose's sessions -- never call the LLM, confirm
      // 'skipped' directly (there is no pending phase to transition out of; nothing was ever run).
      const skipped = this.deps.insertSkipped({
        purposeId,
        createdAt,
        model,
        inputStats: built.stats,
        appealText: appeal?.text ?? null
      })
      this.deps.onEvaluationUpdated(skipped)
      return
    }

    const pending = this.deps.insertPending({
      purposeId,
      createdAt,
      model,
      inputStats: built.stats,
      appealText: appeal?.text ?? null
    })
    this.deps.onEvaluationUpdated(pending)

    const prompt = buildEvaluationPrompt(purposeText, built.promptBody, appeal)

    let raw: string
    try {
      raw = await this.deps.runEvaluation(prompt, model)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.recordFailure(pending.id, `claude の実行に失敗しました: ${message}`)
      return
    }

    const parsed = parseEvaluationResult(raw)
    if (!parsed.ok) {
      this.recordFailure(pending.id, parsed.reason)
      return
    }

    const finalized = this.deps.finalizeOk(pending.id, {
      smoothness: parsed.smoothness,
      stress: parsed.stress,
      commCost: parsed.commCost,
      summary: parsed.summary,
      suggestions: parsed.suggestions
    })
    if (!finalized) return // pending row vanished/already finalized (should not happen in practice)
    this.deps.onEvaluationUpdated(finalized)

    await this.writeReportIfConfigured(finalized, purposeId, purposeText, built.stats)
  }

  private recordFailure(evaluationId: string, reason: string): void {
    const finalized = this.deps.finalizeError(evaluationId, reason)
    if (finalized) this.deps.onEvaluationUpdated(finalized)
  }

  /** D-5: write-through the Markdown+JSON report when an output root is configured. Never lets a report
   * write failure affect the evaluation's own already-finalized 'ok' status (R-5) -- only report_state
   * reflects the outcome, pushed as its own follow-up update. */
  private async writeReportIfConfigured(
    finalized: EvaluationSummary,
    purposeId: string,
    purposeText: string,
    fallbackStats: EvaluationInputStats
  ): Promise<void> {
    const outputRoot = this.deps.getOutputRoot()
    if (!outputRoot) return
    const { smoothness, stress, commCost } = finalized
    if (smoothness === null || stress === null || commCost === null) {
      return // defensive: 'ok' always carries all three scores, but never write a report for anything else
    }

    const reportData = {
      id: finalized.id,
      purposeId,
      purposeText,
      purposeTitle: this.deps.getPurposeTitle(purposeId),
      createdAt: finalized.createdAt,
      model: finalized.model,
      smoothness,
      stress,
      commCost,
      summary: finalized.summary ?? '',
      suggestions: finalized.suggestions,
      inputStats: finalized.inputStats ?? fallbackStats,
      appealText: finalized.appealText
    }
    const markdown = renderEvaluationReportMarkdown(reportData)
    const json = renderEvaluationReportJson(reportData)

    const writeResult = await this.deps.writeReport(outputRoot, finalized.id, markdown, json)
    const reportUpdated = this.deps.setReportState(finalized.id, writeResult.ok ? 'written' : 'error')
    if (reportUpdated) this.deps.onEvaluationUpdated(reportUpdated)
  }
}
