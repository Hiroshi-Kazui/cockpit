import { describe, expect, it, vi } from 'vitest'
import { EvaluationCoordinator, type EvaluationCoordinatorDeps } from './evaluationCoordinator'
import type { EvaluationSummary } from '../../shared/ipc'

function makeSummary(overrides: Partial<EvaluationSummary> = {}): EvaluationSummary {
  return {
    id: 'eval-1',
    purposeId: 'purpose-1',
    createdAt: 1000,
    model: 'haiku',
    status: 'pending',
    smoothness: null,
    stress: null,
    commCost: null,
    summary: null,
    suggestions: [],
    inputStats: null,
    lastError: null,
    reportState: null,
    ...overrides
  }
}

function makeDeps(overrides: Partial<EvaluationCoordinatorDeps> = {}): EvaluationCoordinatorDeps & {
  updates: EvaluationSummary[]
} {
  const updates: EvaluationSummary[] = []
  const deps: EvaluationCoordinatorDeps & { updates: EvaluationSummary[] } = {
    updates,
    getEnabled: () => true,
    getModel: () => 'haiku',
    getOutputRoot: () => null,
    getPurposeText: () => '目的テキスト',
    getPurposeTitle: () => 'タイトル',
    listSessionsForPurpose: () => [{ id: 'session-1', jsonlPath: '/archive/session-1/transcript.jsonl' }],
    readSession: async () => ({ sessionId: 'session-1', userTexts: ['hello'], assistantTexts: ['world'] }),
    insertPending: (params) =>
      makeSummary({
        id: 'eval-pending',
        purposeId: params.purposeId,
        createdAt: params.createdAt,
        model: params.model,
        status: 'pending',
        inputStats: params.inputStats
      }),
    insertSkipped: (params) =>
      makeSummary({
        id: 'eval-skipped',
        purposeId: params.purposeId,
        createdAt: params.createdAt,
        model: params.model,
        status: 'skipped',
        inputStats: params.inputStats
      }),
    finalizeOk: (id, params) =>
      makeSummary({
        id,
        status: 'ok',
        smoothness: params.smoothness,
        stress: params.stress,
        commCost: params.commCost,
        summary: params.summary,
        suggestions: params.suggestions
      }),
    finalizeError: (id, lastError) => makeSummary({ id, status: 'error', lastError }),
    setReportState: (id, state) => makeSummary({ id, status: 'ok', reportState: state }),
    runEvaluation: async () =>
      JSON.stringify({ smoothness: 80, stress: 10, commCost: 5, summary: 'ok', suggestions: [] }),
    writeReport: async () => ({ ok: true }),
    onEvaluationUpdated: (summary) => updates.push(summary),
    now: () => 1000,
    ...overrides
  }
  return deps
}

describe('EvaluationCoordinator', () => {
  it('does nothing when evaluation is disabled', async () => {
    const insertPending = vi.fn()
    const insertSkipped = vi.fn()
    const deps = makeDeps({ getEnabled: () => false, insertPending, insertSkipped })
    const coordinator = new EvaluationCoordinator(deps)

    coordinator.triggerForCompletedPurpose('purpose-1')
    await flushMicrotasks()

    expect(insertPending).not.toHaveBeenCalled()
    expect(insertSkipped).not.toHaveBeenCalled()
    expect(deps.updates).toHaveLength(0)
  })

  it('records a skipped evaluation (no LLM call) when there is no genuine user text', async () => {
    const runEvaluation = vi.fn()
    const deps = makeDeps({
      listSessionsForPurpose: () => [{ id: 's1', jsonlPath: null }],
      readSession: async () => ({ sessionId: 's1', userTexts: [], assistantTexts: [] }),
      runEvaluation
    })
    const coordinator = new EvaluationCoordinator(deps)

    coordinator.triggerForCompletedPurpose('purpose-1')
    await flushMicrotasks()

    expect(runEvaluation).not.toHaveBeenCalled()
    expect(deps.updates).toHaveLength(1)
    expect(deps.updates[0].status).toBe('skipped')
  })

  it('pushes a pending update immediately, then an ok update once the LLM call succeeds', async () => {
    const deps = makeDeps()
    const coordinator = new EvaluationCoordinator(deps)

    coordinator.triggerForCompletedPurpose('purpose-1')
    await flushMicrotasks()

    expect(deps.updates.map((u) => u.status)).toEqual(['pending', 'ok'])
    expect(deps.updates[1].smoothness).toBe(80)
  })

  it('finalizes as error (with a visible reason) when the headless claude call rejects', async () => {
    const deps = makeDeps({
      runEvaluation: async () => {
        throw new Error('claude not found')
      }
    })
    const coordinator = new EvaluationCoordinator(deps)

    coordinator.triggerForCompletedPurpose('purpose-1')
    await flushMicrotasks()

    expect(deps.updates.map((u) => u.status)).toEqual(['pending', 'error'])
    expect(deps.updates[1].lastError).toContain('claude not found')
  })

  it('finalizes as error (never a silent 0-point ok) when the LLM response is unparseable', async () => {
    const deps = makeDeps({ runEvaluation: async () => 'not json at all' })
    const coordinator = new EvaluationCoordinator(deps)

    coordinator.triggerForCompletedPurpose('purpose-1')
    await flushMicrotasks()

    expect(deps.updates.map((u) => u.status)).toEqual(['pending', 'error'])
  })

  it('writes a report and marks report_state=written when an output root is configured', async () => {
    const writeReport = vi.fn(async () => ({ ok: true }))
    const deps = makeDeps({ getOutputRoot: () => '/some/output', writeReport })
    const coordinator = new EvaluationCoordinator(deps)

    coordinator.triggerForCompletedPurpose('purpose-1')
    await flushMicrotasks()

    expect(writeReport).toHaveBeenCalledTimes(1)
    expect(deps.updates.map((u) => u.status)).toEqual(['pending', 'ok', 'ok'])
    expect(deps.updates[2].reportState).toBe('written')
  })

  it('marks report_state=error (without touching the evaluation status) when the report write fails', async () => {
    const deps = makeDeps({
      getOutputRoot: () => '/some/output',
      writeReport: async () => ({ ok: false, reason: 'disk full' })
    })
    const coordinator = new EvaluationCoordinator(deps)

    coordinator.triggerForCompletedPurpose('purpose-1')
    await flushMicrotasks()

    expect(deps.updates.map((u) => u.status)).toEqual(['pending', 'ok', 'ok'])
    expect(deps.updates[2].reportState).toBe('error')
  })

  it('never writes a report when no output root is configured', async () => {
    const writeReport = vi.fn()
    const deps = makeDeps({ getOutputRoot: () => null, writeReport })
    const coordinator = new EvaluationCoordinator(deps)

    coordinator.triggerForCompletedPurpose('purpose-1')
    await flushMicrotasks()

    expect(writeReport).not.toHaveBeenCalled()
    expect(deps.updates.map((u) => u.status)).toEqual(['pending', 'ok'])
  })

  it('rerun() drives the exact same pipeline as triggerForCompletedPurpose()', async () => {
    const deps = makeDeps()
    const coordinator = new EvaluationCoordinator(deps)

    coordinator.rerun('purpose-1')
    await flushMicrotasks()

    expect(deps.updates.map((u) => u.status)).toEqual(['pending', 'ok'])
  })
})

/** Lets every already-scheduled microtask (promise chain) in the fire-and-forget pipeline settle before
 * assertions run -- the coordinator's public methods are deliberately synchronous/non-awaited (D-1). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}
