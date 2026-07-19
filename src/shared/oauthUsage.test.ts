// Unit tests for the tolerant GET /api/oauth/usage response parser (spec §4.5, §7).
import { describe, expect, it } from 'vitest'
import { parseOauthUsageResponse } from './oauthUsage'

describe('parseOauthUsageResponse', () => {
  it('parses a nested rate_limits wrapper shape (matching the statusLine payload shape)', () => {
    const result = parseOauthUsageResponse({
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: 1700000000000 },
        seven_day: { used_percentage: 55, resets_at: 1700600000000 }
      }
    })
    expect(result).toEqual({
      fiveHour: { usedPercentage: 10, resetsAt: 1700000000000 },
      sevenDay: { usedPercentage: 55, resetsAt: 1700600000000 }
    })
  })

  it('parses a flat top-level five_hour/seven_day shape, normalizing epoch-seconds resets_at to ms', () => {
    const result = parseOauthUsageResponse({
      five_hour: { used_percentage: 20, resets_at: 1 },
      seven_day: { used_percentage: 30, resets_at: 2 }
    })
    expect(result).toEqual({
      fiveHour: { usedPercentage: 20, resetsAt: 1000 },
      sevenDay: { usedPercentage: 30, resetsAt: 2000 }
    })
  })

  it('normalizes an already-epoch-milliseconds resets_at unchanged', () => {
    const result = parseOauthUsageResponse({
      rate_limits: { five_hour: { used_percentage: 10, resets_at: 1_700_000_000_000 } }
    })
    expect(result?.fiveHour).toEqual({ usedPercentage: 10, resetsAt: 1_700_000_000_000 })
  })

  it('normalizes an ISO 8601 string resets_at to epoch milliseconds', () => {
    const result = parseOauthUsageResponse({
      rate_limits: { five_hour: { used_percentage: 10, resets_at: '2023-11-14T22:13:20.000Z' } }
    })
    expect(result?.fiveHour).toEqual({
      usedPercentage: 10,
      resetsAt: Date.parse('2023-11-14T22:13:20.000Z')
    })
  })

  it('resolves resets_at to null when missing or malformed', () => {
    const missing = parseOauthUsageResponse({
      rate_limits: { five_hour: { used_percentage: 10 } }
    })
    expect(missing?.fiveHour).toEqual({ usedPercentage: 10, resetsAt: null })

    const malformed = parseOauthUsageResponse({
      rate_limits: { five_hour: { used_percentage: 10, resets_at: 'not-a-date' } }
    })
    expect(malformed?.fiveHour).toEqual({ usedPercentage: 10, resetsAt: null })
  })

  it('tolerates only one window being present', () => {
    const result = parseOauthUsageResponse({ rate_limits: { five_hour: { used_percentage: 5 } } })
    expect(result).toEqual({ fiveHour: { usedPercentage: 5, resetsAt: null }, sevenDay: null })
  })

  it('ignores unknown/extra fields (spec §7 forward-compatibility)', () => {
    const result = parseOauthUsageResponse({
      rate_limits: { five_hour: { used_percentage: 5, extra_field: true } },
      unrelated: 'ignored'
    })
    expect(result?.fiveHour?.usedPercentage).toBe(5)
  })

  it('returns null when the top-level value is not an object', () => {
    expect(parseOauthUsageResponse(null)).toBeNull()
    expect(parseOauthUsageResponse(undefined)).toBeNull()
    expect(parseOauthUsageResponse('not json')).toBeNull()
    expect(parseOauthUsageResponse(42)).toBeNull()
    expect(parseOauthUsageResponse(['array'])).toBeNull()
  })

  it('returns null when neither shape yields any usable window (e.g. an unrelated payload)', () => {
    expect(parseOauthUsageResponse({ foo: 'bar' })).toBeNull()
  })

  it('returns null when both windows are present but entirely unusable (all fields malformed)', () => {
    const result = parseOauthUsageResponse({
      rate_limits: {
        five_hour: { used_percentage: 'not-a-number' },
        seven_day: { used_percentage: null }
      }
    })
    expect(result).toBeNull()
  })

  it('falls back to the flat shape when the nested rate_limits wrapper is present but unusable', () => {
    const result = parseOauthUsageResponse({
      rate_limits: { five_hour: {}, seven_day: {} },
      five_hour: { used_percentage: 7, resets_at: null }
    })
    expect(result?.fiveHour?.usedPercentage).toBe(7)
  })

  // M3 FIX (minor #3): this parser now probes the same camelCase key spellings as
  // shared/statusline.ts's rate_limits parsing (both reuse the same key-probe helpers), so tolerance is
  // symmetric across the two parsers even though the actually-observed shape (see statusline.ts's header
  // comment) is snake_case-only.
  it('tolerates camelCase key spellings for the nested wrapper and both windows', () => {
    const result = parseOauthUsageResponse({
      rateLimits: {
        fiveHour: { usedPercentage: 10, resetsAt: 1 },
        sevenDay: { usedPercentage: 55, resetsAt: 2 }
      }
    })
    expect(result).toEqual({
      fiveHour: { usedPercentage: 10, resetsAt: 1000 },
      sevenDay: { usedPercentage: 55, resetsAt: 2000 }
    })
  })

  it('tolerates camelCase key spellings for the flat top-level shape', () => {
    const result = parseOauthUsageResponse({
      fiveHour: { usedPercentage: 20, resetsAt: 1 },
      sevenDay: { usedPercentage: 30, resetsAt: 2 }
    })
    expect(result).toEqual({
      fiveHour: { usedPercentage: 20, resetsAt: 1000 },
      sevenDay: { usedPercentage: 30, resetsAt: 2000 }
    })
  })
})
