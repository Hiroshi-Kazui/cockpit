// Pure, tolerant parser for the statusLine JSON forwarded from claude via the telemetry pipe
// (spec §4.3, §7, TD-4). Unknown fields are ignored and missing/malformed fields resolve to null
// rather than throwing, so a claude CLI upgrade that changes the schema can never crash the app.
//
// SCHEMA PROVENANCE (verified against live payloads 2026-07-19): this machine's `~/.claude/settings.json`
// already had a user-authored `statusLine` hook (`statusline-remaining.sh`) that dumps its raw stdin
// payload to `~/.claude/statusline-cache.json` (v2.1.215, captured live during this very session) and an
// older raw dump (`statusline-debug-output.json`, v2.1.89, a different project). Both independently
// confirm the *real* top-level shape is: `session_id`, `transcript_path`, `cwd`, `model: {id,
// display_name}`, `workspace`, `version`, `context_window: {total_input_tokens, total_output_tokens,
// context_window_size, current_usage: {input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens}, used_percentage, remaining_percentage}`, and
// `rate_limits: {five_hour: {used_percentage, resets_at}, seven_day: {used_percentage, resets_at}}` --
// exclusively snake_case in both captures, no camelCase variant was ever observed, and there is no
// top-level `context_used_percentage`/flat `context.used_percentage` field, only the nested
// `context_window.used_percentage` this parser's `CONTEXT_PARENT_KEYS` already covers. `resets_at` was
// confirmed to be epoch **seconds** in both captures (e.g. `1775055600`, `1775300400`), matching the
// existing `normalizeResetsAt` heuristic's seconds-vs-ms boundary.
//
// The camelCase key spellings and alternate context-nesting paths this parser also probes for
// (`context_used_percentage`/`contextUsedPercentage`, `rate_limits`/`rateLimits`, `five_hour`/`fiveHour`,
// `used_percentage`/`usedPercentage`, `resets_at`/`resetsAt`, `context.used_percentage`/
// `contextWindow.used_percentage`) are kept solely for spec §7's defensive forward-compatibility
// tolerance -- they were never observed in either live sample above; every field stays optional-safe so
// an unmatched key degrades to "observed as absent", never a crash or a silently-wrong value.
//
// SECURITY (M2 FIX iteration 2): the named pipe this payload arrives over (TD-4) can be connected to by
// any local process running as the same OS user -- it is not authenticated. `session_id` and
// `transcript_path` from this payload end up in filesystem path construction downstream (archive
// directory name, transcript read path), so they must never be trusted blindly. `isValidSessionId` and
// `isTranscriptPathAllowed` below are the pure whitelist/containment checks callers (sessionCoordinator)
// apply at the boundary before any of those values touch a path.
import path from 'node:path'

export interface RateLimitWindow {
  usedPercentage: number | null
  resetsAt: number | null
}

export interface RateLimits {
  fiveHour: RateLimitWindow | null
  sevenDay: RateLimitWindow | null
}

/** One JSON-Lines message received over the telemetry pipe: the original claude statusLine payload
 * plus the `pane` field the forwarder script injects (TD-4). */
export interface StatusLineMessage {
  pane: number | null
  sessionId: string | null
  transcriptPath: string | null
  model: string | null
  contextUsedPercentage: number | null
  rateLimits: RateLimits | null
}

// Exported so shared/oauthUsage.ts can reuse this exact check instead of maintaining a duplicate
// (M3 FIX minor: the two parsers had byte-identical `isRecord` implementations).
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Tries each key in order, returning the first that resolves to a finite number. Used to probe
 * multiple plausible key-name spellings (snake_case/camelCase) for a single logical field. Exported so
 * shared/oauthUsage.ts's fallback-endpoint parser can apply the identical snake/camelCase tolerance
 * (M3 FIX minor #3) instead of maintaining a second, narrower probe of its own. */
export function readNumberAny(
  source: Record<string, unknown>,
  keys: readonly string[]
): number | null {
  for (const key of keys) {
    const value = readNumber(source, key)
    if (value !== null) return value
  }
  return null
}

/** Tries each key in order, returning the raw (unvalidated) value of the first key present. Used ahead
 * of `normalizeResetsAt`, which needs to see the raw value to tell a number from a string. Exported for
 * reuse by shared/oauthUsage.ts (see `readNumberAny` above). */
export function readRaw(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key]
  }
  return undefined
}

/** Tries each key in order, returning the first that resolves to a plain object. Exported for reuse by
 * shared/oauthUsage.ts (see `readNumberAny` above). */
export function readRecordAny(
  source: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> | null {
  for (const key of keys) {
    const value = source[key]
    if (isRecord(value)) return value
  }
  return null
}

/** `model` may be a plain string or an object like `{ id, display_name }`; prefer display_name. */
function readModel(raw: Record<string, unknown>): string | null {
  const model = raw['model']
  if (typeof model === 'string' && model.length > 0) return model
  if (isRecord(model)) {
    return readString(model, 'display_name') ?? readString(model, 'id')
  }
  return null
}

/**
 * Normalizes a `resets_at` value of unknown unit/encoding into epoch milliseconds. Verified against live
 * payloads 2026-07-19 (see file header): the real claude CLI (v2.1.89 and v2.1.215 samples) emits
 * `rate_limits.*.resets_at` as epoch **seconds** (e.g. `1775055600`), which this heuristic already
 * converts correctly (values below the 10^12 boundary are multiplied by 1000). The ISO-8601-string and
 * already-milliseconds branches remain as defensive fallbacks for encodings not observed in either
 * sample -- they were never seen in practice, but keeping them costs nothing and this heuristic accepts
 * all three plausible encodings so a correct guess degrades to "displays the right time" and an
 * incorrect/absent value degrades to null (reset time simply not shown), never a wrong-by-1000x display.
 *
 * Heuristic for numbers: values below 10^12 are treated as epoch *seconds* (and multiplied by 1000);
 * values at or above 10^12 are treated as already epoch *milliseconds*. 10^12 ms corresponds to the
 * year 33658, while 10^12 s corresponds to the year 33658 already elapsed in *seconds* terms too far in
 * the future to be a real seconds timestamp -- concretely, any real-world epoch-seconds timestamp
 * (through year ~33658) is far below 10^12, and any real-world epoch-milliseconds timestamp from the
 * 2001-09-09 onward (when epoch-seconds itself crossed 10^9) is already above 10^12, so the boundary
 * cleanly separates the two encodings for all realistic dates.
 */
export function normalizeResetsAt(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return value < 1_000_000_000_000 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const CONTEXT_USED_PERCENTAGE_FLAT_KEYS = [
  'context_used_percentage',
  'contextUsedPercentage'
] as const
const CONTEXT_PARENT_KEYS = ['context', 'contextWindow', 'context_window'] as const
// Exported (alongside RATE_LIMITS_KEYS/FIVE_HOUR_KEYS/SEVEN_DAY_KEYS below) so shared/oauthUsage.ts's
// fallback-endpoint parser probes the identical snake_case/camelCase key spellings for the rate_limits
// sub-shape rather than only accepting snake_case (M3 FIX minor #3: the two parsers' tolerance was
// asymmetric -- oauthUsage.ts read snake_case keys directly while this file already probed both casings).
// `as const` (M3 FIX minor: readonly tuple) keeps these key lists immutable at the type level -- callers
// can only read them, never accidentally push/reassign into a shared constant.
export const USED_PERCENTAGE_KEYS = ['used_percentage', 'usedPercentage'] as const
export const RESETS_AT_KEYS = ['resets_at', 'resetsAt'] as const
export const RATE_LIMITS_KEYS = ['rate_limits', 'rateLimits'] as const
export const FIVE_HOUR_KEYS = ['five_hour', 'fiveHour'] as const
export const SEVEN_DAY_KEYS = ['seven_day', 'sevenDay'] as const

function readContextUsedPercentage(raw: Record<string, unknown>): number | null {
  const flat = readNumberAny(raw, CONTEXT_USED_PERCENTAGE_FLAT_KEYS)
  if (flat !== null) return flat
  const context = readRecordAny(raw, CONTEXT_PARENT_KEYS)
  return context ? readNumberAny(context, USED_PERCENTAGE_KEYS) : null
}

function readRateLimitWindow(source: unknown): RateLimitWindow | null {
  if (!isRecord(source)) return null
  return {
    usedPercentage: readNumberAny(source, USED_PERCENTAGE_KEYS),
    resetsAt: normalizeResetsAt(readRaw(source, RESETS_AT_KEYS))
  }
}

function readRateLimits(raw: Record<string, unknown>): RateLimits | null {
  const rateLimits = readRecordAny(raw, RATE_LIMITS_KEYS)
  if (!rateLimits) return null
  return {
    fiveHour: readRateLimitWindow(readRaw(rateLimits, FIVE_HOUR_KEYS)),
    sevenDay: readRateLimitWindow(readRaw(rateLimits, SEVEN_DAY_KEYS))
  }
}

// Conservative filename-safe charset: letters, digits, `.`, `_`, `-`. Excludes path separators
// (`/`, `\`) and any other character that could carry special meaning to the filesystem.
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * Whitelist check for `session_id` values arriving over the telemetry pipe. A `session_id` that fails
 * this check must never be used to build a filesystem path (archive directory name) -- it is rejected
 * outright rather than sanitized, since the value is also used as a stable identifier elsewhere (DB
 * primary key), where silently mangling it would cause worse (mismatched) bugs than simply discarding
 * the message. `..` is checked explicitly in addition to the charset match as defense-in-depth (a
 * charset of `.` alone technically allows a literal `..` segment).
 */
export function isValidSessionId(value: string): boolean {
  return value.length > 0 && SESSION_ID_PATTERN.test(value) && !value.includes('..')
}

/**
 * Verifies a `transcript_path` is an absolute path located inside the expected claude transcripts
 * directory (`claudeHomeDir`, normally `<home>/.claude`) before the archiver is ever allowed to open it
 * for reading. Without this check, a spoofed/malformed pipe message could make the archiver read (and
 * copy into our own on-disk archive) an arbitrary file elsewhere on the machine. `claudeHomeDir` is
 * passed in rather than computed here so this stays a pure, unit-testable function.
 */
export function isTranscriptPathAllowed(transcriptPath: string, claudeHomeDir: string): boolean {
  if (!path.isAbsolute(transcriptPath)) return false
  const normalizedHome = path.resolve(claudeHomeDir)
  const normalizedTarget = path.resolve(transcriptPath)
  const relative = path.relative(normalizedHome, normalizedTarget)
  // relative === '' would mean transcriptPath *is* claudeHomeDir itself (not a file inside it) --
  // treated as not allowed, same as an escaping ('..'-prefixed) or absolute (different-drive) relative
  // path.
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Parse one JSON-Lines message from the telemetry pipe. Returns null only when `raw` is not even a
 * JSON object (i.e. completely unusable); every individual field is optional (spec §7).
 */
export function parseStatusLineMessage(raw: unknown): StatusLineMessage | null {
  if (!isRecord(raw)) return null
  return {
    pane: readNumber(raw, 'pane'),
    sessionId: readString(raw, 'session_id'),
    transcriptPath: readString(raw, 'transcript_path'),
    model: readModel(raw),
    contextUsedPercentage: readContextUsedPercentage(raw),
    rateLimits: readRateLimits(raw)
  }
}
