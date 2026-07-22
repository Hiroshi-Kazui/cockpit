// Reads a purpose's already-archived session transcripts for evaluation input (ADR-0010 D-1: "入力は
// アーカイブ（スプール）のみから読む。pty・元 JSONL には触れない"). Read-only by construction, same
// discipline as main/archive/archiveReader.ts -- the only fs calls here are realpath/readFile, no write
// path exists. Deliberately does NOT reuse archiveReader's MAX_DISPLAY_TURNS cap (that exists for a
// human-facing viewer's DOM/IPC-payload size, an unrelated concern) -- shared/evaluation.ts's
// buildEvaluationInput applies its own char-budget cap, which is what actually matters for the LLM prompt.
import fs from 'node:fs'
import { parseJsonlLineForDisplay } from '../../shared/jsonl'
import { resolveContainedPath } from '../../shared/paths'
import type { EvaluationSessionInput } from '../../shared/evaluation'

export interface EvaluationTranscriptReaderDeps {
  /** `fs.promises.realpath` -- resolves symlinks, defense-in-depth layer 2 (mirrors archiveReader.ts). */
  realpath: (path: string) => Promise<string>
  readFile: (path: string) => Promise<string>
}

const defaultDeps: EvaluationTranscriptReaderDeps = {
  realpath: (p) => fs.promises.realpath(p),
  readFile: (p) => fs.promises.readFile(p, 'utf-8')
}

/**
 * Reads one session's archived transcript (spool copy) and extracts every user/assistant turn's text, in
 * transcript order, via the same permissive `parseJsonlLineForDisplay` the M5 session viewer uses
 * (appropriate here too: evaluation cares about "what actually happened in the conversation", not the
 * stricter human-authorship-only extraction shared/jsonl.ts's `readUserText`/purpose-auto-detection uses).
 *
 * Never throws: a missing/unreadable/out-of-bounds transcript resolves to an empty session input (so one
 * bad session can never abort evaluating the rest of a purpose's sessions) -- the caller
 * (evaluationCoordinator.ts) still records this session's id in the purpose's session count via its own
 * bookkeeping, so the fact that no text was recoverable is visible in input_stats, not silently dropped
 * from the count entirely.
 */
export async function readSpoolSessionForEvaluation(
  archiveRoot: string,
  sessionId: string,
  jsonlPath: string | null,
  deps: EvaluationTranscriptReaderDeps = defaultDeps
): Promise<EvaluationSessionInput> {
  const empty: EvaluationSessionInput = { sessionId, userTexts: [], assistantTexts: [] }
  if (!jsonlPath) return empty

  const contained = resolveContainedPath(archiveRoot, jsonlPath)
  if (contained === null) return empty

  let realRoot: string
  let realTarget: string
  try {
    realRoot = await deps.realpath(archiveRoot)
    realTarget = await deps.realpath(contained)
  } catch {
    return empty
  }
  if (resolveContainedPath(realRoot, realTarget) === null) return empty

  let raw: string
  try {
    raw = await deps.readFile(realTarget)
  } catch {
    return empty
  }

  const userTexts: string[] = []
  const assistantTexts: string[] = []
  for (const line of raw.split('\n')) {
    const turn = parseJsonlLineForDisplay(line)
    if (!turn) continue
    if (turn.role === 'user') userTexts.push(turn.text)
    else assistantTexts.push(turn.text)
  }
  return { sessionId, userTexts, assistantTexts }
}
