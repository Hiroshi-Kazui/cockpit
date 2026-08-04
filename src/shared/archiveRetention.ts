// Pure, tolerant policy for M10 archive line retention (spec §4.4/§4.4.1, ADR-0011): decides which raw
// transcript JSONL lines are worth persisting into the app-managed archive, and supports recovering a
// re-attach read offset once the archive is no longer a byte-for-byte prefix of the source (D-4). This
// module performs no I/O of its own (no fs/DB/Electron) -- `main/archive/archiver.ts` is the only impure
// caller, so this stays unit-testable in isolation (CLAUDE.md: shared/ is test-first). It also stays
// runtime-safe if ever imported from the renderer (nodeIntegration:false): no `Buffer` (Node-only global)
// is used here.
//
// Policy shape (ADR-0011/D-3, denylist): only the line shapes explicitly listed in
// milestones/M10-archive-line-retention/acceptance.md R-3 are discarded. Everything else -- including any
// unknown `type`/`attachment.type`/`system.subtype`, malformed JSON, and content in an unexpected shape --
// is retained (R-5, spec §7's tolerant-parser principle: never silently lose information a future CLI
// version might add).

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** R-3: `type: "attachment"` payloads that are pure machine-generated noise (hook success/async echoes,
 * routine mode/skill/permission bookkeping) -- the bulk of the 96% reduction (ADR-0011 background).
 * `queued_command` is deliberately NOT in this list (D-3a): it is the only record of a human interrupting
 * a running agent turn, so it is retained, not discarded. */
const DISCARD_ATTACHMENT_TYPES = new Set<string>([
  'hook_success',
  'async_hook_response',
  'task_reminder',
  'skill_listing',
  'agent_listing_delta',
  'deferred_tools_delta',
  'command_permissions',
  'auto_mode',
  'plan_mode',
  'plan_mode_exit',
  'hook_cancelled',
  'hook_system_message',
  'nested_memory',
  'file',
  'compact_file_reference',
  'edited_text_file'
])

/** R-3: `type: "system"` subtypes that are routine bookkeeping rather than an analyzable event. */
const DISCARD_SYSTEM_SUBTYPES = new Set<string>([
  'stop_hook_summary',
  'local_command',
  'scheduled_task_fire'
])

/** R-3: top-level `type` values that are per-turn UI/bookkeeping duplicates with no analytic content. */
const DISCARD_TOP_LEVEL_TYPES = new Set<string>([
  'mode',
  'permission-mode',
  'ai-title',
  'last-prompt',
  'pr-link',
  'queue-operation',
  'file-history-snapshot',
  'file-history-delta'
])

/** True only when `content` is a non-empty array whose blocks are *all* `tool_result` -- the one `user`
 * shape R-3 discards (Bash stdout / file contents fed back to the model, reproducible from code, never
 * mixed with a human-authored `text`/`image` block in practice -- ADR-0011 background). Any other shape
 * (a plain string, a text-only array, an image+text array, a mixed tool_result+text array, or anything
 * unexpected) is left alone here and falls through to "retain" (R-5). */
function isToolResultOnlyContent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false
  return content.every((block) => isRecord(block) && block['type'] === 'tool_result')
}

function shouldRetainParsedEntry(entry: Record<string, unknown>): boolean {
  const type = entry['type']

  if (type === 'user') {
    const message = entry['message']
    const content = isRecord(message) ? message['content'] : undefined
    return !isToolResultOnlyContent(content)
  }

  if (type === 'assistant') return true

  if (type === 'attachment') {
    const attachment = entry['attachment']
    if (!isRecord(attachment)) return true // missing/malformed attachment field -> retain (R-5)
    const attachmentType = attachment['type']
    if (typeof attachmentType !== 'string') return true
    return !DISCARD_ATTACHMENT_TYPES.has(attachmentType)
  }

  if (type === 'system') {
    const subtype = entry['subtype']
    if (typeof subtype !== 'string') return true
    return !DISCARD_SYSTEM_SUBTYPES.has(subtype)
  }

  if (typeof type === 'string' && DISCARD_TOP_LEVEL_TYPES.has(type)) return false

  return true // unknown type -> retain (R-5)
}

/**
 * Decides whether one raw JSONL line (exactly as it appears in the source transcript, without the
 * trailing newline) should be appended to the archive. Never throws. Blank/whitespace-only lines are
 * never retained (nothing to persist, matches the pre-M10 behavior of such lines never producing a
 * parsed entry either -- see shared/jsonl.ts's parseJsonlLine).
 */
export function shouldRetainLine(rawLine: string): boolean {
  const trimmed = rawLine.trim()
  if (trimmed.length === 0) return false

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return true // malformed JSON -> retain (R-5): never lose information we can't understand
  }
  if (!isRecord(parsed)) return true // e.g. a top-level JSON array/string -> retain (R-5)

  return shouldRetainParsedEntry(parsed)
}

/** Extracts the `uuid` field of one raw JSONL line, or null if absent/malformed. Used to anchor resume
 * offset recovery (D-4) -- ADR-0011 background confirms every retained line shape carries a `uuid` in
 * practice, so this being null is expected only for discarded/unknown-shape lines. */
export function extractUuid(rawLine: string): string | null {
  const trimmed = rawLine.trim()
  if (trimmed.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const uuid = parsed['uuid']
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : null
}

/** Scans `lines` (already-decided-retained raw JSONL lines, in original order) backward for the last one
 * that carries a `uuid`, returning it, or `fallback` if none of them do (C2 fix). This mirrors
 * `main/archive/archiver.ts`'s `readArchiveAnchor`, which walks the archive backward skipping past any
 * uuid-less tail lines to find the last line that *does* carry a uuid -- before this fix, the sidecar's
 * `lastUuid` was instead simply overwritten with the uuid of whichever line happened to be *last in a given
 * sync batch*, which regressed to `null` whenever that last line was a uuid-less R-5 tolerant-fallback line
 * even though an earlier line (same batch, or a previous sync) already established a real uuid. That
 * regression made the sidecar and the archive's own anchor computation disagree about where the tail is
 * anchored, forcing a `scan` resume that lands just past the *anchor* line -- not past the uuid-less line(s)
 * already archived after it -- and re-appending that already-archived tail on every reattach. */
export function lastRetainedUuid(lines: readonly string[], fallback: string | null): string | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const uuid = extractUuid(lines[i])
    if (uuid !== null) return uuid
  }
  return fallback
}

/** The re-attach resume sidecar's parsed shape (ADR-0011/D-4: `archive-state.json`, written temp+rename
 * by main/archive/archiver.ts). `lastUuid` is the `uuid` of the last line actually appended to the
 * archive at the time `sourceOffset` was recorded (null if that line had no `uuid`, or none has been
 * appended yet). */
export interface ResumeSidecar {
  sourceOffset: number
  lastUuid: string | null
}

/** Parses a sidecar payload. Throws (does not return a fallback value) on malformed JSON or an invalid
 * shape -- callers (archiver.ts) must catch this explicitly and report it via `onError` before falling
 * back to a safe resume route, per R-6 ("例外を投げて握り潰さない": failures must be surfaced, not
 * silently swallowed into a default). */
export function parseSidecar(raw: string): ResumeSidecar {
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) {
    throw new Error('archive-state.json: expected a JSON object')
  }
  const sourceOffset = parsed['sourceOffset']
  if (typeof sourceOffset !== 'number' || !Number.isFinite(sourceOffset) || sourceOffset < 0) {
    throw new Error('archive-state.json: sourceOffset is missing or not a non-negative number')
  }
  const lastUuid = parsed['lastUuid']
  if (lastUuid !== null && typeof lastUuid !== 'string') {
    throw new Error('archive-state.json: lastUuid is missing or not a string/null')
  }
  return { sourceOffset, lastUuid }
}

/**
 * What the archive itself (independent of the sidecar) tells us about where its own content ends, used to
 * anchor re-attach resume decisions (B2 fix -- previously this was collapsed into a bare
 * `archiveLastUuid: string | null`, which could not distinguish "archive is genuinely empty" from "archive
 * has content but that content happens to carry no uuid", and caused a non-empty archive to be silently
 * re-read from byte 0, duplicating every retained line in it):
 *
 * - `empty`: the archive file does not exist or has zero retained lines in it.
 * - `uuid`: the archive's last non-blank line carries a `uuid` (the overwhelming common case -- every
 *   retained line shape carries one in practice, ADR-0011 background).
 * - `noUuid`: the archive has at least one line, but scanning it found none with a `uuid` at all (only
 *   possible if every retained line so far was an unknown-type line kept purely under R-5's tolerant
 *   fallback -- a pathological edge case, not the normal path).
 */
export type ArchiveAnchor = { kind: 'empty' } | { kind: 'uuid'; uuid: string } | { kind: 'noUuid' }

/** The four possible outcomes of a re-attach resume decision (R-6, ADR-0011/D-4, B2/C1 fixes). */
export type ResumeDecision =
  | { kind: 'sidecar'; sourceOffset: number }
  | { kind: 'scan'; targetUuid: string }
  | { kind: 'zero' }
  | { kind: 'unsafe'; reason: string }

/**
 * Decides how to recover the source read offset on re-attach (app restart / `/resume` / crash recovery),
 * given the sidecar state read from disk (already parsed and validated by the caller -- `null` covers both
 * "no sidecar file" and "sidecar present but failed to parse/validate", which degrade the same way here)
 * and what the archive's own content anchors to (`archiveAnchor`, read by the caller).
 *
 * - `archiveAnchor.kind === 'uuid'`:
 *   - Sidecar present and its `lastUuid` matches the archive's actual last line -> `sidecar`: the
 *     sidecar's `sourceOffset` is trustworthy (clean shutdown, or reattach with nothing new).
 *   - Otherwise (no sidecar at all, or its `lastUuid` is stale -- the append-before-sidecar-update crash
 *     window, ADR-0011/D-4) -> `scan`: the only safe anchor is the archive's own last line's uuid.
 *
 *     C1 fix: a "no sidecar" reattach used to short-circuit straight to `{ kind: 'legacyArchiveSize' }`,
 *     adopting the archive file's own byte size as the source offset on the *unverified assumption* that
 *     "no sidecar" only ever means "pre-M10 archive, a byte-for-byte verbatim copy of the source" (the one
 *     case where archive size and source offset genuinely coincide). But "no sidecar" is exactly as true
 *     of a post-M10, selectively-retained archive that lost its sidecar (crash before the first sidecar
 *     write, a restored mirror snapshot that never copied the sidecar, or a user following this module's
 *     own now-retired "remove archive-state.json to retry" guidance) -- for that archive shape, size and
 *     source offset have no relationship at all, and adopting the size lands mid-line in the source,
 *     corrupting the next read. Routing through `scan` unconditionally instead costs a bounded source
 *     scan, but is verified safe for both shapes: a genuinely-verbatim pre-M10 archive's anchor uuid still
 *     appears exactly once in the source, so `scan` finds the identical offset `legacyArchiveSize` would
 *     have adopted, at the cost of one linear pass instead of a `stat()` call.
 * - `archiveAnchor.kind === 'empty'`:
 *   - No sidecar -> `zero`: genuinely nothing recorded anywhere, a fresh session.
 *   - Sidecar present with `lastUuid === null` -> `sidecar`: a legitimate "some leading source bytes were
 *     read and every line in them was discarded" state (the archive staying empty does not mean no
 *     progress was made) -- trusting this avoids re-parsing (and, worse, re-emitting via `onEntries`,
 *     double-counting usage/purpose-detection) that same source range every reattach.
 *   - Sidecar present with a non-null `lastUuid` -> `unsafe`: contradicts the archive being empty (e.g.
 *     the archive file was deleted or truncated out-of-band); guessing either `zero` or the sidecar's
 *     offset here could duplicate or lose data, so this is surfaced instead (B2 fix).
 * - `archiveAnchor.kind === 'noUuid'` (archive has content, but no line in it carries a uuid to anchor
 *   on):
 *   - Sidecar present with `lastUuid === null` (consistent with the archive) -> `sidecar`.
 *   - Otherwise -> `unsafe`: there is no reliable way to resume without risking duplication or loss (B2
 *     fix: this must never silently fall back to `zero`, which would re-append the archive's *entire*
 *     existing content once the source is re-read from byte 0).
 */
export function decideResumeOffset(input: {
  sidecar: ResumeSidecar | null
  archiveAnchor: ArchiveAnchor
}): ResumeDecision {
  const { sidecar, archiveAnchor } = input

  if (archiveAnchor.kind === 'uuid') {
    if (sidecar !== null && sidecar.lastUuid === archiveAnchor.uuid) {
      return { kind: 'sidecar', sourceOffset: sidecar.sourceOffset }
    }
    return { kind: 'scan', targetUuid: archiveAnchor.uuid }
  }

  if (archiveAnchor.kind === 'empty') {
    if (sidecar === null) return { kind: 'zero' }
    if (sidecar.lastUuid === null) return { kind: 'sidecar', sourceOffset: sidecar.sourceOffset }
    return {
      kind: 'unsafe',
      reason: 'archive-state.json records a last retained uuid but the archive itself is empty'
    }
  }

  // archiveAnchor.kind === 'noUuid'
  if (sidecar !== null && sidecar.lastUuid === null) {
    return { kind: 'sidecar', sourceOffset: sidecar.sourceOffset }
  }
  return {
    kind: 'unsafe',
    reason: 'archive has content but no line in it carries a uuid to resume from'
  }
}
