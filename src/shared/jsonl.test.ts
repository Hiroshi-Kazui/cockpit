// Unit tests for the tolerant claude transcript JSONL line parser and usage aggregation (spec §7, §4.5).
import { describe, expect, it } from 'vitest'
import {
  addUsage,
  aggregateUsage,
  emptyUsage,
  parseJsonlLine,
  parseJsonlLineForDisplay,
  shouldLogOriginDrift
} from './jsonl'

describe('parseJsonlLine', () => {
  it('parses an assistant turn with nested message.usage and message.model', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-5-20250929',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5
        }
      },
      timestamp: '2026-07-19T12:00:00.000Z'
    })
    expect(parseJsonlLine(line)).toEqual({
      timestampMs: Date.parse('2026-07-19T12:00:00.000Z'),
      model: 'claude-sonnet-4-5-20250929',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5 },
      userText: null,
      isUserTurnMissingHumanOrigin: false
    })
  })

  // M3 FIX (task B): mirrors the real shape observed in a live transcript (see file header) -- a full
  // assistant usage object carries several sibling keys beyond the four this parser reads.
  it('reads only the known keys from a real-shaped usage object with extra sibling fields', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 31277,
          cache_read_input_tokens: 17825,
          output_tokens: 963,
          server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
          service_tier: 'standard',
          cache_creation: { ephemeral_1h_input_tokens: 31277, ephemeral_5m_input_tokens: 0 },
          inference_geo: 'not_available',
          speed: 'standard'
        }
      },
      timestamp: '2026-07-19T05:07:13.554Z'
    })
    expect(parseJsonlLine(line)).toEqual({
      timestampMs: Date.parse('2026-07-19T05:07:13.554Z'),
      model: 'claude-opus-4-8',
      usage: {
        inputTokens: 2,
        outputTokens: 963,
        cacheReadTokens: 17825,
        cacheCreationTokens: 31277
      },
      userText: null,
      isUserTurnMissingHumanOrigin: false
    })
  })

  it('returns null for blank lines', () => {
    expect(parseJsonlLine('')).toBeNull()
    expect(parseJsonlLine('   \n')).toBeNull()
  })

  it('returns null for invalid JSON instead of throwing (partial/corrupt line tolerance)', () => {
    expect(parseJsonlLine('{"type": "assistant", "message": ')).toBeNull()
  })

  it('returns null usage/model/timestamp for entries missing them (spec §7 field-level tolerance)', () => {
    const result = parseJsonlLine(JSON.stringify({ type: 'user', message: { role: 'user' } }))
    // No `origin` field at all -> also flagged as missing human origin (see the userText describe block
    // below for dedicated origin-drift-flag coverage).
    expect(result).toEqual({
      timestampMs: null,
      model: null,
      usage: null,
      userText: null,
      isUserTurnMissingHumanOrigin: true
    })
  })

  it('ignores unknown top-level and nested fields', () => {
    const result = parseJsonlLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-haiku',
          usage: { input_tokens: 1, output_tokens: 1 },
          extra: 'x'
        },
        uuid: 'abc',
        someFutureField: { a: 1 }
      })
    )
    expect(result?.model).toBe('claude-haiku')
    expect(result?.usage).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    })
  })

  it('falls back to a top-level model/usage when not nested under message', () => {
    const result = parseJsonlLine(
      JSON.stringify({ model: 'claude-opus-4', usage: { input_tokens: 3, output_tokens: 4 } })
    )
    expect(result?.model).toBe('claude-opus-4')
    expect(result?.usage?.inputTokens).toBe(3)
  })

  it('accepts a numeric epoch-ms timestamp', () => {
    const result = parseJsonlLine(JSON.stringify({ timestamp: 1700000000000 }))
    expect(result?.timestampMs).toBe(1700000000000)
  })
})

// M4 (spec §4.2 "目的が空で開始した場合"): userText extraction, exercising the shapes verified against
// a live transcript (see jsonl.ts's file header).
describe('parseJsonlLine userText extraction', () => {
  it('extracts a genuine human|typed|string turn', () => {
    const result = parseJsonlLine(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'READMEにセットアップ手順を追記して' },
        origin: { kind: 'human' },
        promptSource: 'typed'
      })
    )
    expect(result?.userText).toBe('READMEにセットアップ手順を追記して')
  })

  it('extracts a genuine human|queued|string turn (typed while agent was busy)', () => {
    const result = parseJsonlLine(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'queued message' },
        origin: { kind: 'human' },
        promptSource: 'queued'
      })
    )
    expect(result?.userText).toBe('queued message')
  })

  it('extracts the text block of a human turn with an array content (e.g. pasted image + caption)', () => {
    const result = parseJsonlLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'この画面を見て' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xx' } }
          ]
        },
        origin: { kind: 'human' },
        promptSource: 'typed'
      })
    )
    expect(result?.userText).toBe('この画面を見て')
  })

  it('returns null for a tool_result-only array turn (not something the human typed)', () => {
    const result = parseJsonlLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'ok', tool_use_id: 'toolu_1' }]
        }
      })
    )
    expect(result?.userText).toBeNull()
  })

  it('returns null for a task-notification turn (origin.kind !== human)', () => {
    const result = parseJsonlLine(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '<task-notification>...</task-notification>' },
        origin: { kind: 'task-notification' },
        promptSource: 'system'
      })
    )
    expect(result?.userText).toBeNull()
  })

  it('returns null for a built-in slash command echo wrapped in <command-name> (no origin field)', () => {
    const result = parseJsonlLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content:
            '<command-name>/model</command-name>\n            <command-args>fable</command-args>'
        }
      })
    )
    expect(result?.userText).toBeNull()
  })

  it('returns null for a <local-command-caveat> wrapper (no origin field)', () => {
    const result = parseJsonlLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: '<local-command-caveat>Caveat: ...</local-command-caveat>'
        }
      })
    )
    expect(result?.userText).toBeNull()
  })

  it('returns null for a headless claude -p sdk-sourced turn even without a distinguishing origin', () => {
    const result = parseJsonlLine(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'この目的を要約して20字のタイトルを出力してください' },
        promptSource: 'sdk'
      })
    )
    expect(result?.userText).toBeNull()
  })

  it('returns null for a custom-command markdown-body injection (array:text, no origin field -- would otherwise be indistinguishable from real typed text by content shape alone)', () => {
    const result = parseJsonlLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '# /cockpit-build コマンド本文...' }]
        }
      })
    )
    expect(result?.userText).toBeNull()
  })

  it('returns null for a plain string turn with no origin field at all (strict human-origin requirement)', () => {
    const result = parseJsonlLine(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'looks like a real message' }
      })
    )
    expect(result?.userText).toBeNull()
  })

  it('returns null for a non-"user" type entry', () => {
    const result = parseJsonlLine(
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi' } })
    )
    expect(result?.userText).toBeNull()
  })

  // FIX (minor #7): pins the sdk/system exclusion's behavior even though it is currently unreachable
  // (every real sdk/system turn observed lacks origin.kind==='human', see file header) -- documents intent
  // as defense-in-depth against a hypothetical future CLI that mistags a headless turn with human origin.
  it('returns null for an sdk-sourced turn even if it were (hypothetically) tagged with origin.kind===human', () => {
    const result = parseJsonlLine(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'この目的を要約して20字のタイトルを出力してください' },
        origin: { kind: 'human' },
        promptSource: 'sdk'
      })
    )
    expect(result?.userText).toBeNull()
  })
})

// FIX (minor, origin-drift diagnostic -- purity pass): `isUserTurnMissingHumanOrigin` is plain data (no
// side effect) -- main/telemetry/purposeDetectionCoordinator.ts is the impure consumer that tallies/logs
// it (see purposeDetectionCoordinator.test.ts).
describe('parseJsonlLine isUserTurnMissingHumanOrigin flag', () => {
  it('is true for a user-role turn with no origin field at all', () => {
    const result = parseJsonlLine(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'looks like a real message' }
      })
    )
    expect(result?.isUserTurnMissingHumanOrigin).toBe(true)
  })

  it('is true for a user-role turn whose origin.kind is not human', () => {
    const result = parseJsonlLine(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '<task-notification>...</task-notification>' },
        origin: { kind: 'task-notification' },
        promptSource: 'system'
      })
    )
    expect(result?.isUserTurnMissingHumanOrigin).toBe(true)
  })

  it('is false for a genuine human-origin turn', () => {
    const result = parseJsonlLine(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'READMEにセットアップ手順を追記して' },
        origin: { kind: 'human' },
        promptSource: 'typed'
      })
    )
    expect(result?.isUserTurnMissingHumanOrigin).toBe(false)
  })

  it('is false for a non-"user" type entry (assistant turns are not in scope)', () => {
    const result = parseJsonlLine(
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi' } })
    )
    expect(result?.isUserTurnMissingHumanOrigin).toBe(false)
  })

  it('is false when message.role is not "user" even if type is "user"', () => {
    const result = parseJsonlLine(
      JSON.stringify({ type: 'user', message: { role: 'assistant', content: 'not a user turn' } })
    )
    expect(result?.isUserTurnMissingHumanOrigin).toBe(false)
  })
})

// M4 FIX (minor #6, origin-drift diagnostic): the pure sampling decision consumed by the impure
// occurrence-counting/console.warn in main/telemetry/purposeDetectionCoordinator.ts -- tested here in
// isolation, independent of any counter or side effect.
describe('shouldLogOriginDrift', () => {
  it('always logs the very first occurrence', () => {
    expect(shouldLogOriginDrift(1)).toBe(true)
  })

  it('does not log every occurrence in between (would flood the log for routine tool_result/sdk turns)', () => {
    expect(shouldLogOriginDrift(2)).toBe(false)
    expect(shouldLogOriginDrift(50)).toBe(false)
    expect(shouldLogOriginDrift(199)).toBe(false)
  })

  it('samples every 200th occurrence thereafter', () => {
    expect(shouldLogOriginDrift(200)).toBe(true)
    expect(shouldLogOriginDrift(400)).toBe(true)
    expect(shouldLogOriginDrift(600)).toBe(true)
  })
})

// M5 (spec §4.4 "ユーザ⇔エージェントのやり取りを整形表示"): the past-session viewer's display-turn
// extraction, deliberately more permissive than readUserText's strict origin.kind==='human' gate (see
// jsonl.ts's parseJsonlLineForDisplay doc comment for why).
describe('parseJsonlLineForDisplay', () => {
  it('extracts a user turn with plain string content', () => {
    const result = parseJsonlLineForDisplay(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'READMEにセットアップ手順を追記して' },
        origin: { kind: 'human' },
        timestamp: '2026-07-19T12:00:00.000Z'
      })
    )
    expect(result).toEqual({
      role: 'user',
      text: 'READMEにセットアップ手順を追記して',
      timestampMs: Date.parse('2026-07-19T12:00:00.000Z')
    })
  })

  it('extracts a user turn even without origin.kind===human (browsing shows what actually happened)', () => {
    const result = parseJsonlLineForDisplay(
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'no origin field here' } })
    )
    expect(result?.text).toBe('no origin field here')
    expect(result?.role).toBe('user')
  })

  it('extracts the text block of a user turn with array content (text + image)', () => {
    const result = parseJsonlLineForDisplay(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'この画面を見て' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xx' } }
          ]
        }
      })
    )
    expect(result?.text).toBe('この画面を見て')
  })

  it('extracts an assistant turn with plain string content', () => {
    const result = parseJsonlLineForDisplay(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: '了解しました。対応します。' },
        timestamp: 1700000000000
      })
    )
    expect(result).toEqual({
      role: 'assistant',
      text: '了解しました。対応します。',
      timestampMs: 1700000000000
    })
  })

  it('extracts the text block of an assistant turn with array content (text + tool_use)', () => {
    const result = parseJsonlLineForDisplay(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'ファイルを確認します' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } }
          ]
        }
      })
    )
    expect(result?.text).toBe('ファイルを確認します')
    expect(result?.role).toBe('assistant')
  })

  it('returns null for a pure tool_use assistant turn with no text block', () => {
    const result = parseJsonlLineForDisplay(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }]
        }
      })
    )
    expect(result).toBeNull()
  })

  it('returns null for a tool_result-only user turn (not something the human typed)', () => {
    const result = parseJsonlLineForDisplay(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'ok', tool_use_id: 'toolu_1' }]
        }
      })
    )
    expect(result).toBeNull()
  })

  it('returns null for a slash-command echo wrapped in <command-name> (still filtered for readability)', () => {
    const result = parseJsonlLineForDisplay(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: '<command-name>/model</command-name>\n<command-args>fable</command-args>'
        }
      })
    )
    expect(result).toBeNull()
  })

  it('returns null for blank lines', () => {
    expect(parseJsonlLineForDisplay('')).toBeNull()
    expect(parseJsonlLineForDisplay('   ')).toBeNull()
  })

  it('returns null for invalid JSON instead of throwing', () => {
    expect(parseJsonlLineForDisplay('{"type": "user", "message": ')).toBeNull()
  })

  it('returns null for a non-user/non-assistant type (e.g. a system entry)', () => {
    const result = parseJsonlLineForDisplay(
      JSON.stringify({ type: 'system', message: { role: 'system', content: 'init' } })
    )
    expect(result).toBeNull()
  })

  it('returns null when message.role does not match type', () => {
    const result = parseJsonlLineForDisplay(
      JSON.stringify({ type: 'user', message: { role: 'assistant', content: 'mismatched' } })
    )
    expect(result).toBeNull()
  })

  it('returns null when message is missing entirely', () => {
    expect(parseJsonlLineForDisplay(JSON.stringify({ type: 'user' }))).toBeNull()
  })
})

describe('addUsage / aggregateUsage', () => {
  it('sums two usage objects field-by-field', () => {
    const a = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 }
    const b = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40 }
    expect(addUsage(a, b)).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheCreationTokens: 44
    })
  })

  it('aggregates usage across parsed entries, skipping entries with no usage', () => {
    const entries = [
      {
        timestampMs: 1,
        model: null,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        userText: null,
        isUserTurnMissingHumanOrigin: false
      },
      {
        timestampMs: 2,
        model: null,
        usage: null,
        userText: null,
        isUserTurnMissingHumanOrigin: false
      },
      {
        timestampMs: 3,
        model: null,
        usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 0 },
        userText: null,
        isUserTurnMissingHumanOrigin: false
      }
    ]
    expect(aggregateUsage(entries)).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 1,
      cacheCreationTokens: 0
    })
  })

  it('aggregates an empty list to zero usage', () => {
    expect(aggregateUsage([])).toEqual(emptyUsage())
  })
})
