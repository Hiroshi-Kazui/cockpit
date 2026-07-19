// Unit tests for the tolerant statusLine pipe-message parser (spec §7, TD-4).
import { describe, expect, it } from 'vitest'
import {
  isTranscriptPathAllowed,
  isValidSessionId,
  normalizeResetsAt,
  parseStatusLineMessage
} from './statusline'

describe('parseStatusLineMessage', () => {
  it('parses a full payload including rate_limits and nested model', () => {
    const result = parseStatusLineMessage({
      pane: 2,
      session_id: 'sess-123',
      transcript_path: 'C:\\Users\\me\\.claude\\projects\\p\\sess-123.jsonl',
      model: { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
      context: { used_percentage: 42.5 },
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: 1700000000000 },
        seven_day: { used_percentage: 55, resets_at: 1700600000000 }
      }
    })
    expect(result).toEqual({
      pane: 2,
      sessionId: 'sess-123',
      transcriptPath: 'C:\\Users\\me\\.claude\\projects\\p\\sess-123.jsonl',
      model: 'Claude Sonnet 4.5',
      contextUsedPercentage: 42.5,
      rateLimits: {
        fiveHour: { usedPercentage: 10, resetsAt: 1700000000000 },
        sevenDay: { usedPercentage: 55, resetsAt: 1700600000000 }
      }
    })
  })

  it('accepts model as a plain string', () => {
    const result = parseStatusLineMessage({ session_id: 's', model: 'claude-haiku' })
    expect(result?.model).toBe('claude-haiku')
  })

  it('falls back to model.id when display_name is absent', () => {
    const result = parseStatusLineMessage({ model: { id: 'claude-opus-4' } })
    expect(result?.model).toBe('claude-opus-4')
  })

  it('treats every field as optional -- an empty object parses to all-null, not a throw', () => {
    expect(parseStatusLineMessage({})).toEqual({
      pane: null,
      sessionId: null,
      transcriptPath: null,
      model: null,
      contextUsedPercentage: null,
      rateLimits: null
    })
  })

  it('ignores unknown/extra fields (spec §7 forward-compatibility)', () => {
    const result = parseStatusLineMessage({
      session_id: 's',
      some_future_field: { nested: true },
      hook_event_name: 'Status'
    })
    expect(result?.sessionId).toBe('s')
  })

  it('returns null only when the top-level value is not an object', () => {
    expect(parseStatusLineMessage(null)).toBeNull()
    expect(parseStatusLineMessage(undefined)).toBeNull()
    expect(parseStatusLineMessage('not json')).toBeNull()
    expect(parseStatusLineMessage(42)).toBeNull()
    expect(parseStatusLineMessage(['array'])).toBeNull()
  })

  it('tolerates a partially malformed rate_limits shape without throwing', () => {
    const result = parseStatusLineMessage({
      session_id: 's',
      rate_limits: { five_hour: { used_percentage: 'not-a-number' }, seven_day: null }
    })
    expect(result?.rateLimits).toEqual({
      fiveHour: { usedPercentage: null, resetsAt: null },
      sevenDay: null
    })
  })

  it('reads context usage from a flat context_used_percentage field as a fallback shape', () => {
    const result = parseStatusLineMessage({ context_used_percentage: 12 })
    expect(result?.contextUsedPercentage).toBe(12)
  })

  // M3 FIX iteration 2 (major #3): the real payload's key casing is still unverified, so the parser
  // defensively probes camelCase equivalents too. These cases only prove the widened candidate list is
  // wired up correctly -- they do not confirm which spelling (if any) claude actually emits.
  it('reads context usage from a flat camelCase contextUsedPercentage field', () => {
    const result = parseStatusLineMessage({ contextUsedPercentage: 33 })
    expect(result?.contextUsedPercentage).toBe(33)
  })

  it('reads context usage from a nested contextWindow.used_percentage shape', () => {
    const result = parseStatusLineMessage({ contextWindow: { used_percentage: 71 } })
    expect(result?.contextUsedPercentage).toBe(71)
  })

  it('reads context usage from a nested context.usedPercentage (camelCase leaf) shape', () => {
    const result = parseStatusLineMessage({ context: { usedPercentage: 20 } })
    expect(result?.contextUsedPercentage).toBe(20)
  })

  it('reads rate_limits from a camelCase rateLimits/fiveHour/sevenDay wrapper with camelCase leaves', () => {
    const result = parseStatusLineMessage({
      rateLimits: {
        fiveHour: { usedPercentage: 15, resetsAt: 1700000000000 },
        sevenDay: { usedPercentage: 60, resetsAt: 1700600000000 }
      }
    })
    expect(result?.rateLimits).toEqual({
      fiveHour: { usedPercentage: 15, resetsAt: 1700000000000 },
      sevenDay: { usedPercentage: 60, resetsAt: 1700600000000 }
    })
  })

  // M3 FIX (task B, verified against live payloads 2026-07-19; see file header): this is the real
  // top-level shape captured from this machine's own statusLine hook, trimmed to the fields this parser
  // reads. Context usage is nested under `context_window.used_percentage`, not a flat
  // `context`/`context_used_percentage` field, and `resets_at` is epoch seconds.
  it('parses the real statusLine payload shape (context_window nesting, epoch-seconds resets_at)', () => {
    const result = parseStatusLineMessage({
      session_id: 'ec3df89e-e2c8-42c5-9d9d-62b97a1a4418',
      transcript_path:
        'C:\\Users\\me\\.claude\\projects\\p\\ec3df89e-e2c8-42c5-9d9d-62b97a1a4418.jsonl',
      cwd: 'C:\\develop\\counselor',
      model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
      version: '2.1.89',
      context_window: {
        total_input_tokens: 385,
        total_output_tokens: 840,
        context_window_size: 200000,
        current_usage: {
          input_tokens: 1,
          output_tokens: 157,
          cache_creation_input_tokens: 1555,
          cache_read_input_tokens: 21888
        },
        used_percentage: 12,
        remaining_percentage: 88
      },
      exceeds_200k_tokens: false,
      rate_limits: {
        five_hour: { used_percentage: 14.000000000000002, resets_at: 1775055600 },
        seven_day: { used_percentage: 11, resets_at: 1775300400 }
      }
    })
    expect(result?.sessionId).toBe('ec3df89e-e2c8-42c5-9d9d-62b97a1a4418')
    expect(result?.model).toBe('Opus 4.6')
    expect(result?.contextUsedPercentage).toBe(12)
    expect(result?.rateLimits).toEqual({
      fiveHour: { usedPercentage: 14.000000000000002, resetsAt: 1775055600 * 1000 },
      sevenDay: { usedPercentage: 11, resetsAt: 1775300400 * 1000 }
    })
  })

  it('reads a mixed snake_case wrapper with a camelCase leaf field', () => {
    const result = parseStatusLineMessage({
      rate_limits: { five_hour: { usedPercentage: 8, resets_at: 1700000000000 } }
    })
    expect(result?.rateLimits?.fiveHour).toEqual({ usedPercentage: 8, resetsAt: 1700000000000 })
  })
})

describe('normalizeResetsAt', () => {
  it('passes through a value already in epoch milliseconds (>= 10^12)', () => {
    expect(normalizeResetsAt(1_700_000_000_000)).toBe(1_700_000_000_000)
  })

  it('multiplies an epoch-seconds value (< 10^12) by 1000', () => {
    expect(normalizeResetsAt(1_700_000_000)).toBe(1_700_000_000_000)
  })

  it('treats the 10^12 boundary itself as already milliseconds (inclusive)', () => {
    expect(normalizeResetsAt(1_000_000_000_000)).toBe(1_000_000_000_000)
  })

  it('treats just under the boundary as seconds', () => {
    expect(normalizeResetsAt(999_999_999_999)).toBe(999_999_999_999_000)
  })

  it('parses an ISO 8601 string into epoch milliseconds', () => {
    expect(normalizeResetsAt('2023-11-14T22:13:20.000Z')).toBe(
      Date.parse('2023-11-14T22:13:20.000Z')
    )
  })

  it('resolves to null for an unparseable string', () => {
    expect(normalizeResetsAt('not-a-date')).toBeNull()
  })

  it('resolves to null for an empty string', () => {
    expect(normalizeResetsAt('')).toBeNull()
  })

  it('resolves to null for non-finite numbers', () => {
    expect(normalizeResetsAt(NaN)).toBeNull()
    expect(normalizeResetsAt(Infinity)).toBeNull()
  })

  it('resolves to null for missing/unsupported types', () => {
    expect(normalizeResetsAt(undefined)).toBeNull()
    expect(normalizeResetsAt(null)).toBeNull()
    expect(normalizeResetsAt(true)).toBeNull()
    expect(normalizeResetsAt({})).toBeNull()
  })
})

// M2 FIX iteration 2 (security): session_id/transcript_path arrive over an unauthenticated named pipe
// (TD-4) and are used to build filesystem paths downstream, so they must be validated before any path
// construction happens.
describe('isValidSessionId', () => {
  it('accepts a UUID-shaped session id', () => {
    expect(isValidSessionId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true)
  })

  it('accepts a plain alphanumeric id', () => {
    expect(isValidSessionId('sess_123.abc-XYZ')).toBe(true)
  })

  it('rejects an id containing ..', () => {
    expect(isValidSessionId('..')).toBe(false)
    expect(isValidSessionId('..\\..\\evil')).toBe(false)
    expect(isValidSessionId('a..b')).toBe(false)
  })

  it('rejects an id containing a path separator', () => {
    expect(isValidSessionId('foo/bar')).toBe(false)
    expect(isValidSessionId('foo\\bar')).toBe(false)
  })

  it('rejects an empty id', () => {
    expect(isValidSessionId('')).toBe(false)
  })

  it('rejects ids containing other special/symbol characters', () => {
    expect(isValidSessionId('sess$123')).toBe(false)
    expect(isValidSessionId('sess 123')).toBe(false)
    expect(isValidSessionId('sess:123')).toBe(false)
    expect(isValidSessionId('C:\\evil')).toBe(false)
  })
})

describe('isTranscriptPathAllowed', () => {
  const claudeHome = 'C:\\Users\\me\\.claude'

  it('accepts an absolute path nested under the claude home dir', () => {
    expect(
      isTranscriptPathAllowed('C:\\Users\\me\\.claude\\projects\\p\\sess-1.jsonl', claudeHome)
    ).toBe(true)
  })

  it('rejects a relative path', () => {
    expect(isTranscriptPathAllowed('projects\\p\\sess-1.jsonl', claudeHome)).toBe(false)
  })

  it('rejects an absolute path outside the claude home dir', () => {
    expect(isTranscriptPathAllowed('C:\\Windows\\System32\\config\\SAM', claudeHome)).toBe(false)
  })

  it('rejects an absolute path that escapes via .. segments', () => {
    expect(isTranscriptPathAllowed('C:\\Users\\me\\.claude\\..\\..\\secret.txt', claudeHome)).toBe(
      false
    )
  })

  it('rejects the claude home dir itself (must be a file inside it, not the dir)', () => {
    expect(isTranscriptPathAllowed(claudeHome, claudeHome)).toBe(false)
  })
})
