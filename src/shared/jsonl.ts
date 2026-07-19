// Pure, tolerant parser for claude transcript JSONL lines (spec §4.4/§4.5, §7). The on-disk format is
// undocumented and version-dependent; unknown fields are ignored and missing usage/model/timestamp
// resolve to null rather than throwing, so archiving/token-aggregation never crashes on a CLI upgrade.
//
// M3 FIX (task B, verified against a live transcript 2026-07-19): read directly from this repo's own
// active session transcript (`~/.claude/projects/C--develop-cockpit/<session_id>.jsonl`, claude CLI
// v2.1.215). Assistant `message.usage` entries use exactly the key names this parser already reads --
// `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` -- alongside
// several unread keys (`server_tool_use`, `service_tier`, `cache_creation`, `inference_geo`, `iterations`,
// `speed`) that are correctly ignored. The top-level `timestamp` field is an ISO 8601 string and
// `message.model` is a plain string, matching `readTimestamp`/`readModel` below. No parser changes were
// needed; this comment documents the verification.
//
// M4 (spec §4.2 "目的が空で開始した場合", verified against the same live transcripts 2026-07-19, claude
// CLI v2.1.215): `readUserText` below extracts genuine human-typed chat text so shared/purposeDetection.ts
// can find a session's first real message. Observed `type: "user"` turn shapes in
// `~/.claude/projects/C--develop-cockpit/*.jsonl`:
//   - `human|typed|string`   -- a normal typed message; `message.content` is a plain string.
//   - `human|typed|array`    -- typed message with an attachment (e.g. a pasted screenshot);
//                               `message.content` is `[{type:'text',...}, {type:'image',...}]`.
//   - `human|queued|string`  -- typed while the agent was still busy, queued for delivery; still
//                               genuinely human-authored.
//   - `(none)|(none)|array:tool_result` -- a tool result being fed back to the model. NOT user input.
//   - `(none)|(none)|array:text` -- a custom slash command's full markdown body being injected as
//                               "typed" text (e.g. `/cockpit-build`'s command file contents). No `origin`
//                               field at all. NOT something the human actually typed themselves.
//   - `(none)|(none)|string` -- `<local-command-caveat>...` wrapper around local-command echoes.
//   - `task-notification|system|string` -- `<task-notification>...` background-task auto-injection.
//   - `(none)|sdk|string`    -- a headless `claude -p` one-shot's own prompt turn (e.g. this app's own
//                               title generator); lives in a wholly separate transcript file in practice,
//                               but excluded defensively here too.
//   - built-in slash commands (e.g. `/model fable`) are recorded as a **string** wrapped in
//     `<command-name>/model</command-name>...` -- never as literal text beginning with `/`.
// Every genuinely human-authored turn observed carries `origin.kind === 'human'`; every synthetic one
// (tool results, task-notifications, sdk turns, and -- critically -- the custom-slash-command markdown
// body injection, which has no `<command-name>`-style wrapper to pattern-match on and would otherwise be
// indistinguishable from real typed text) has no `origin` field at all or a non-`human` kind. `readUserText`
// therefore requires `origin.kind === 'human'` strictly, rather than falling back to a content-shape
// heuristic when `origin` is absent: for this app's purpose-text-detection use (spec §4.2), a false
// negative (an old/future CLI version without `origin` metadata simply never auto-detects a purpose,
// leaving it "未設定") is far preferable to a false positive (a slash/skill command's expanded body
// silently becoming the recorded "目的" and a nonsense generated title).

export interface JsonlUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface ParsedJsonlEntry {
  timestampMs: number | null
  model: string | null
  usage: JsonlUsage | null
  /** The untrimmed, as-authored text of a genuine human-typed chat turn, or null if this JSONL entry
   * is not one (assistant turn, tool_result echo, task-notification, headless-claude-p turn, slash-command
   * echo, etc. -- see the file header comment above). May be an empty/whitespace-only string if the human
   * sent nothing but whitespace; callers (shared/purposeDetection.ts) are responsible for trimming/
   * filtering that out, this field only decides "was this authored by the human at the keyboard". */
  userText: string | null
  /** M4 FIX (minor, origin-drift diagnostic -- purity pass): true when this entry is a `type==='user'` /
   * `message.role==='user'` turn that lacks a genuine `origin.kind==='human'` tag (no `origin` field at
   * all, or a non-`human` kind) -- i.e. it has the shape of a real human-typed message but the transcript's
   * own metadata doesn't confirm that. This is expected and harmless for the ordinary synthetic turns this
   * parser already excludes from `userText` by design (tool_result echoes, task-notifications, sdk turns --
   * see file header), so it is *not* itself an error signal; it is surfaced here as plain data purely so an
   * impure caller (main/telemetry/purposeDetectionCoordinator.ts) can tally occurrences over time and emit a
   * low-frequency diagnostic (see `shouldLogOriginDrift`) if genuine human turns ever stop carrying
   * `origin.kind==='human'` after a claude CLI upgrade, which would silently break spec §4.2's purpose
   * auto-detection. This parser itself performs no I/O and holds no state -- it only reports the fact. */
  isUserTurnMissingHumanOrigin: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** claude transcript entries carry `usage` nested under `message` for assistant turns; tolerate a
 * top-level `usage` too in case the shape differs for other entry types. */
function readUsage(entry: Record<string, unknown>): JsonlUsage | null {
  const message = entry['message']
  const usageSource =
    isRecord(message) && isRecord(message['usage']) ? message['usage'] : entry['usage']
  if (!isRecord(usageSource)) return null
  return {
    inputTokens: readNumber(usageSource, 'input_tokens'),
    outputTokens: readNumber(usageSource, 'output_tokens'),
    cacheReadTokens: readNumber(usageSource, 'cache_read_input_tokens'),
    cacheCreationTokens: readNumber(usageSource, 'cache_creation_input_tokens')
  }
}

function readModel(entry: Record<string, unknown>): string | null {
  const message = entry['message']
  if (isRecord(message) && typeof message['model'] === 'string' && message['model'].length > 0) {
    return message['model']
  }
  const direct = entry['model']
  return typeof direct === 'string' && direct.length > 0 ? direct : null
}

function readTimestamp(entry: Record<string, unknown>): number | null {
  const ts = entry['timestamp']
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts)
    return Number.isNaN(parsed) ? null : parsed
  }
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts
  return null
}

/** Wrapper prefixes for `type: "user"` turns that are not something a human typed even though they carry
 * plain-string content (see file header). This is defense-in-depth alongside the strict `origin.kind ===
 * 'human'` requirement below (guards the -- unobserved in practice -- case of a synthetic echo somehow
 * being tagged with human origin by a future CLI version). */
const SYNTHETIC_TEXT_PREFIXES = [
  '<command-name>',
  '<local-command-caveat>',
  '<task-notification>'
] as const

function isSyntheticEcho(text: string): boolean {
  const trimmed = text.trimStart()
  return SYNTHETIC_TEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

/** Extracts `message.content` text blocks for an array-shaped content (a human turn with a text caption
 * alongside e.g. a pasted image); returns null if there is no text block at all (a tool_result-only
 * array is an echo, not something the human typed). Also used by `parseJsonlLineForDisplay` below for
 * assistant turns' array content (text blocks alongside tool_use blocks). */
function readArrayContentText(content: readonly unknown[]): string | null {
  const parts = content
    .filter(isRecord)
    .filter((part) => part['type'] === 'text' && typeof part['text'] === 'string')
    .map((part) => part['text'] as string)
  return parts.length > 0 ? parts.join('\n') : null
}

/** `message.content` may be a plain string or an array of typed blocks (text/image/tool_use/...);
 * returns the concatenated text, or null if there is no text content at all (e.g. a pure tool_use turn).
 * Shared by both branches of `parseJsonlLineForDisplay` below. */
function readMessageText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return readArrayContentText(content)
  return null
}

/** M4 FIX (minor #6, origin-drift diagnostic): decides whether the Nth observed "`type==='user'` turn
 * without `origin.kind==='human'`" occurrence should be logged. Pure -- the occurrence counting and the
 * `console.warn` itself live in the impure caller (main/telemetry/purposeDetectionCoordinator.ts), which
 * tallies `isUserTurnMissingHumanOrigin` across the batches it already scans. Always logs the very first
 * occurrence (so drift is visible immediately after a CLI upgrade), then samples sparsely (every 200th) so
 * the ordinary high-volume legitimate cases this already expects (tool_result echoes, task-notifications,
 * sdk turns -- all `type==='user'` with no/non-human origin *by design*, see file header) never flood the
 * log. */
export function shouldLogOriginDrift(occurrenceCount: number): boolean {
  return occurrenceCount === 1 || occurrenceCount % 200 === 0
}

/** True when `entry` has the shape of a `type==='user'`/`message.role==='user'` turn but lacks a genuine
 * `origin.kind==='human'` tag -- see `ParsedJsonlEntry.isUserTurnMissingHumanOrigin`'s doc comment. Shares
 * the same "is this a user-role turn" precondition as `readUserText` below but is evaluated independently
 * (as plain data, not a side effect) so this module stays free of any I/O or module-level state. */
function isUserTurnMissingHumanOrigin(entry: Record<string, unknown>): boolean {
  if (entry['type'] !== 'user') return false
  const message = entry['message']
  if (!isRecord(message) || message['role'] !== 'user') return false
  const origin = entry['origin']
  return !isRecord(origin) || origin['kind'] !== 'human'
}

/** See the file header comment (M4, spec §4.2/§7) for the verified shapes this distinguishes. */
function readUserText(entry: Record<string, unknown>): string | null {
  if (entry['type'] !== 'user') return null
  const message = entry['message']
  if (!isRecord(message) || message['role'] !== 'user') return null

  const origin = entry['origin']
  if (!isRecord(origin) || origin['kind'] !== 'human') return null

  const promptSource = entry['promptSource']
  // FIX (minor #7): `origin.kind === 'human'` is required above, and every headless/system turn observed
  // in practice (see file header) carries no `origin` field at all (or a non-`human` kind) -- so this
  // sdk/system exclusion is unreachable in current transcripts and exists purely as defense-in-depth
  // against a hypothetical future CLI version that tags a headless/system turn with `origin.kind:'human'`
  // by mistake. Covered by the 'sdk'-with-human-origin test below.
  if (promptSource === 'sdk' || promptSource === 'system') return null

  const content = message['content']
  let text: string | null = null
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = readArrayContentText(content)
  }
  if (text === null || isSyntheticEcho(text)) return null
  return text
}

/** Parse one line of a claude transcript JSONL file. Returns null for blank lines or invalid JSON
 * (never throws) so a single malformed/partial line cannot abort archiving of the rest of the file. */
export function parseJsonlLine(line: string): ParsedJsonlEntry | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  return {
    timestampMs: readTimestamp(raw),
    model: readModel(raw),
    usage: readUsage(raw),
    userText: readUserText(raw),
    isUserTurnMissingHumanOrigin: isUserTurnMissingHumanOrigin(raw)
  }
}

/** One human-readable conversation turn extracted from a transcript line, for the M5 read-only past-
 * session viewer (spec §4.4 "ユーザ⇔エージェントのやり取りを整形表示"). */
export interface JsonlDisplayTurn {
  role: 'user' | 'assistant'
  text: string
  timestampMs: number | null
}

/**
 * M5 (spec §4.4): extracts one display turn (user prompt or assistant reply) from a raw transcript JSONL
 * line, for the read-only past-session browser. Deliberately a *different, more permissive* extraction
 * than `readUserText` above: `readUserText` exists solely to auto-detect the single canonical purpose-
 * defining message (spec §4.2) and so strictly requires `origin.kind === 'human'`, excluding slash-
 * command echoes and other synthetic turns on purpose. This function's job is instead to faithfully
 * replay "what happened" in a past session for browsing, so it surfaces every user/assistant turn that
 * carries renderable text, without the origin-kind gate (a slash-command echo showing up in the browsed
 * transcript is expected and desired here -- it really did appear in the conversation). Returns null for:
 * blank lines, invalid JSON, entries that are neither a user nor an assistant turn, and turns with no
 * text content at all (e.g. a pure tool_use/tool_result turn with no accompanying text block -- rendering
 * raw tool-call payloads is out of scope for this milestone's viewer).
 */
export function parseJsonlLineForDisplay(line: string): JsonlDisplayTurn | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  const type = raw['type']
  const message = raw['message']
  if (!isRecord(message)) return null

  if (type === 'user' && message['role'] === 'user') {
    const text = readMessageText(message['content'])
    if (text === null || isSyntheticEcho(text)) return null
    return { role: 'user', text, timestampMs: readTimestamp(raw) }
  }
  if (type === 'assistant' && message['role'] === 'assistant') {
    const text = readMessageText(message['content'])
    if (text === null) return null
    return { role: 'assistant', text, timestampMs: readTimestamp(raw) }
  }
  return null
}

export function emptyUsage(): JsonlUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
}

export function addUsage(a: JsonlUsage, b: JsonlUsage): JsonlUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens
  }
}

/** Sum usage across a batch of parsed entries (entries with no usage contribute zero). */
export function aggregateUsage(entries: readonly ParsedJsonlEntry[]): JsonlUsage {
  return entries.reduce(
    (acc, entry) => (entry.usage ? addUsage(acc, entry.usage) : acc),
    emptyUsage()
  )
}
