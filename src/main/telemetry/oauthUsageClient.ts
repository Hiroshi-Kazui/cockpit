// Fallback usage fetch: single-shot GET against the non-public oauth/usage endpoint (spec §4.5, §7 --
// this endpoint is undocumented and may change/disappear without notice, and is documented to
// rate-limit aggressively even at low frequency, which is exactly why callers
// (usageFallbackScheduler.ts) must only ever invoke this at most once per idle period, never on an
// interval). Never throws; resolves to null on any failure so a bad/absent credential or a
// network/HTTP/parse error simply leaves the caller in estimated-fallback mode.
//
// NOTE (verified against a live installation 2026-07-19): `~/.claude/.credentials.json` exists on this
// machine and has the shape `{ claudeAiOauth: { accessToken, refreshToken, expiresAt,
// refreshTokenExpiresAt, scopes, subscriptionType, rateLimitTier } }` -- the access token is nested under
// `claudeAiOauth`, not a top-level `accessToken`/`access_token` field. readAccessTokenBestEffort() below
// already tries the nested `claudeAiOauth.accessToken` path (after a top-level check that this real file
// never satisfies, kept only as a defensive fallback for older/different installs never sampled), so no
// code change was needed here -- the existing logic already reads the real file correctly. If nothing
// recognizable is found, no Authorization header is sent (best-effort, still attempts the unauthenticated
// request); the request/response handling around it stays defensive regardless (never throws, treats any
// failure identically to "no rate_limits available"), since only one install was sampled and the
// `subscriptionType`/`rateLimitTier` fields (unused here) suggest the shape may still vary by plan.
//
// Like telemetry/pipeServer.ts's net.Server transport, the actual HTTPS I/O here is a thin OS/network
// side effect and is not unit-tested directly; only the pure response parser
// (shared/oauthUsage.ts's parseOauthUsageResponse) is.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { parseOauthUsageResponse } from '../../shared/oauthUsage'
import type { RateLimits } from '../../shared/statusline'

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const REQUEST_TIMEOUT_MS = 10_000

function readAccessTokenBestEffort(): string | null {
  const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json')
  try {
    const raw = fs.readFileSync(credentialsPath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const direct = record['accessToken'] ?? record['access_token']
    if (typeof direct === 'string' && direct.length > 0) return direct
    const oauth = record['claudeAiOauth']
    if (typeof oauth === 'object' && oauth !== null) {
      const nested = (oauth as Record<string, unknown>)['accessToken']
      if (typeof nested === 'string' && nested.length > 0) return nested
    }
    return null
  } catch (err) {
    // M3 FIX iteration 2 (minor #7): ENOENT is the *normal* case for an API-key-based login (no OAuth
    // credentials file at all) -- not worth logging. Anything else (JSON parse failure, permission
    // denial, etc.) means a credentials file exists but couldn't be used, which is worth a debug-level
    // note since it silently degrades to an unauthenticated request that will likely fail.
    //
    // M3 FIX (minor #1): never log `err` (or `err.message`) itself here. `JSON.parse` throws a
    // `SyntaxError` whose `.message` can embed a fragment of the malformed input -- and the input in this
    // catch is the credentials file, which may contain a live `accessToken`. Logging only the error's
    // `name` and (if present) `code` gives enough signal to diagnose "credentials file exists but is
    // unusable" without ever risking a token fragment reaching logs.
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      const name = err instanceof Error ? err.name : 'UnknownError'
      console.debug('[usage] could not read/parse claude credentials file', { name, code })
    }
    return null
  }
}

/** Performs the single GET. Resolves to null on any failure (auth, network, non-2xx, timeout, parse) --
 * callers must treat null as "stay in estimated mode", never as a crash. */
export function fetchFallbackUsage(): Promise<RateLimits | null> {
  return new Promise((resolve) => {
    const token = readAccessTokenBestEffort()
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    let settled = false
    const finish = (result: RateLimits | null): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const req = https.get(OAUTH_USAGE_URL, { headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          console.error(`[usage] fallback usage endpoint returned status ${res.statusCode}`)
          finish(null)
          return
        }
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
          finish(parseOauthUsageResponse(body))
        } catch (err) {
          console.error('[usage] failed to parse fallback usage response', err)
          finish(null)
        }
      })
      res.on('error', (err) => {
        console.error('[usage] fallback usage response stream error', err)
        finish(null)
      })
    })
    req.on('timeout', () => {
      req.destroy(new Error('fallback usage request timed out'))
    })
    req.on('error', (err) => {
      console.error('[usage] fallback usage request failed', err)
      finish(null)
    })
  })
}
