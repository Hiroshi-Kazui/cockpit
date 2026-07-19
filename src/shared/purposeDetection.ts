// Pure logic for spec §4.2's "目的が空で開始した場合": deciding a purpose's text from the first
// non-command, non-empty human chat turn of its transcript. Consumes the same ParsedJsonlEntry[]
// batches shared/jsonl.ts already produces for archiving/token-aggregation (see
// main/telemetry/purposeDetectionCoordinator.ts for the stateful, DB-driven wiring).
import type { ParsedJsonlEntry } from './jsonl'

/** Real built-in slash commands (e.g. `/model fable`) are recorded in the transcript wrapped as
 * `<command-name>/model</command-name>...` rather than as literal text beginning with `/` (verified
 * against a live v2.1.215 transcript, 2026-07-19) -- jsonl.ts's readUserText already excludes that
 * wrapped form entirely (it is not something a human "said", so it never reaches userText at all). The
 * literal `/`-prefix check below is spec §4.2's own stated contract ("`/` で始まる発言") and additionally
 * guards custom skill/slash invocations from any CLI version or configuration that *does* record them as
 * literal text reaching this point. */
export function isSlashOrSkillInvocation(text: string): boolean {
  return text.trim().startsWith('/')
}

/**
 * Scans a session's parsed JSONL entries, in transcript order, for the first candidate purpose text: the
 * first human-typed, non-empty, non-slash-command chat turn (spec §4.2). Returns null if none of the
 * given entries qualify -- the caller keeps calling this across successive batches (and, via TD-2's
 * active-purpose continuation across `/clear`, successive sessions under the same purpose) until it does.
 * The returned text is trimmed.
 */
export function findFirstPurposeCandidate(entries: readonly ParsedJsonlEntry[]): string | null {
  for (const entry of entries) {
    if (entry.userText === null) continue
    const trimmed = entry.userText.trim()
    if (trimmed.length === 0) continue
    if (isSlashOrSkillInvocation(trimmed)) continue
    return trimmed
  }
  return null
}
