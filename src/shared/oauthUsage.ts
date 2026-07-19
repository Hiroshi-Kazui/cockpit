// Pure, tolerant parser for the fallback GET /api/oauth/usage response body (spec §4.5, §7). This
// endpoint is undocumented and its schema is unverified against a live response in this milestone (see
// main/telemetry/oauthUsageClient.ts's doc comment for why) -- the parser is deliberately as tolerant as
// shared/statusline.ts's rate_limits parsing (which this mirrors), trying both a nested `rate_limits`
// wrapper (matching the statusLine payload shape) and a flat top-level five_hour/seven_day shape, and
// resolving to null on anything unrecognized rather than throwing.
//
// M3 FIX (minor #3): key-name tolerance now reuses shared/statusline.ts's own snake_case/camelCase
// key-probe helpers (`readNumberAny`/`readRaw`/`readRecordAny`) and key-name constants
// (`*_KEYS`) instead of reading only the snake_case key directly -- the two parsers previously had
// asymmetric tolerance (statusline.ts probed both casings, this file accepted only snake_case) with no
// stated reason for the difference. Reusing the same helpers/constants keeps the two parsers' tolerance
// provably identical going forward; the real observed shape (spec §4.3, statusline.ts's header comment)
// is still snake_case-only, so this only widens defensive tolerance, it does not change behavior for any
// currently-observed payload.
import {
  FIVE_HOUR_KEYS,
  RATE_LIMITS_KEYS,
  RESETS_AT_KEYS,
  SEVEN_DAY_KEYS,
  USED_PERCENTAGE_KEYS,
  isRecord,
  normalizeResetsAt,
  readNumberAny,
  readRaw,
  readRecordAny
} from './statusline'
import type { RateLimits, RateLimitWindow } from './statusline'

// M3 FIX (task A): resets_at must go through the same seconds/ms/ISO normalization as the statusLine
// path (shared/statusline.ts's normalizeResetsAt) rather than being read as a raw number -- this fallback
// fetch endpoint is not guaranteed to use the same unit as the statusLine payload, and reading it raw
// silently degrades any seconds/ISO reply into a wrong-by-1000x (or NaN) reset time. normalizeResetsAt is
// the single normalization entrypoint shared by both parsers.
function readWindow(source: unknown): RateLimitWindow | null {
  if (!isRecord(source)) return null
  return {
    usedPercentage: readNumberAny(source, USED_PERCENTAGE_KEYS),
    resetsAt: normalizeResetsAt(readRaw(source, RESETS_AT_KEYS))
  }
}

/** Only returns a usable result when at least one window carries a usable value -- an object with both
 * windows entirely absent/unusable is treated the same as "nothing here", so the caller can try the next
 * candidate shape (or give up) rather than propagating an all-null-but-technically-present result. */
function readWindows(source: Record<string, unknown>): RateLimits | null {
  const fiveHour = readWindow(readRaw(source, FIVE_HOUR_KEYS))
  const sevenDay = readWindow(readRaw(source, SEVEN_DAY_KEYS))
  if ((fiveHour?.usedPercentage ?? null) === null && (sevenDay?.usedPercentage ?? null) === null) {
    return null
  }
  return { fiveHour, sevenDay }
}

/**
 * Parse the fallback usage endpoint's response body. Returns null for anything unrecognizable (not an
 * object, or neither the nested `rate_limits.{five_hour,seven_day}` shape nor a flat top-level
 * `{five_hour,seven_day}` shape yields a usable window) -- callers (main/telemetry/oauthUsageClient.ts)
 * must treat null as "this fetch produced nothing usable", never as a crash.
 */
export function parseOauthUsageResponse(raw: unknown): RateLimits | null {
  if (!isRecord(raw)) return null
  const nested = readRecordAny(raw, RATE_LIMITS_KEYS)
  if (nested) {
    const fromNested = readWindows(nested)
    if (fromNested) return fromNested
  }
  return readWindows(raw)
}
