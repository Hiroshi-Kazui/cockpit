// Unit tests for M10 archive line retention (spec §4.4/§4.4.1, ADR-0011). `shouldRetainLine` decides
// which raw JSONL lines are worth persisting into the archive; `extractUuid`/`lastRetainedUuid`/
// `parseSidecar`/`decideResumeOffset` support the re-attach offset recovery (ADR-0011/D-4). All pure --
// see milestones/M10-archive-line-retention/acceptance.md R-2/R-3/R-5/R-6 for the exact fixtures this
// pins down. (The forward source-scan for a target uuid used to also have a pure duplicate here,
// `findResumeOffsetByUuid` -- unit-tested but never called in production, while the impure chunked scan
// main/archive/archiver.ts actually calls had no unit test of its own. Removed as part of the FIX-3
// major cleanup; main/archive/archiver.test.ts now unit-tests the real chunked scan directly via its
// exported `scanChunksForLastUuidOffset`.)
import { describe, expect, it } from 'vitest'
import {
  decideResumeOffset,
  extractUuid,
  lastRetainedUuid,
  parseSidecar,
  shouldRetainLine
} from './archiveRetention'

function line(entry: unknown): string {
  return JSON.stringify(entry)
}

describe('shouldRetainLine — R-2 retained shapes', () => {
  it('retains a user turn whose content is text blocks only', () => {
    expect(
      shouldRetainLine(
        line({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: 'hi' }] } })
      )
    ).toBe(true)
  })

  it('retains a user turn whose content is a plain string', () => {
    expect(
      shouldRetainLine(line({ type: 'user', uuid: 'u2', message: { content: 'hi there' } }))
    ).toBe(true)
  })

  it('retains a user turn with image + text content (keeps the human caption)', () => {
    expect(
      shouldRetainLine(
        line({
          type: 'user',
          uuid: 'u3',
          message: {
            content: [
              { type: 'image', source: { data: 'xxx' } },
              { type: 'text', text: 'look at this' }
            ]
          }
        })
      )
    ).toBe(true)
  })

  it('retains an assistant turn with text/thinking/tool_use blocks', () => {
    expect(
      shouldRetainLine(
        line({
          type: 'assistant',
          uuid: 'a1',
          message: {
            content: [
              { type: 'thinking', thinking: '...' },
              { type: 'text', text: 'ok' },
              { type: 'tool_use', name: 'Bash', input: {} }
            ],
            usage: { input_tokens: 1, output_tokens: 1 }
          }
        })
      )
    ).toBe(true)
  })

  it.each([
    'hook_blocking_error',
    'hook_additional_context',
    'plan_file_reference',
    'invoked_skills'
  ])('retains attachment.type=%s', (attType) => {
    expect(
      shouldRetainLine(line({ type: 'attachment', uuid: 'x1', attachment: { type: attType } }))
    ).toBe(true)
  })

  // D-3a / B3 fix: queued_command is the only record of a human interrupting a running agent turn
  // (H: measurement: 26/45 such lines had origin.kind:"human", 24 of them with no matching `type:"user"`
  // line elsewhere) -- it must be retained regardless of `origin`, never conditioned on its value.
  it.each([
    { label: 'origin.kind human', origin: { kind: 'human' } },
    { label: 'origin null (task-notification)', origin: null },
    { label: 'origin.kind auto-continuation', origin: { kind: 'auto-continuation' } }
  ])('retains attachment.type=queued_command regardless of origin ($label)', ({ origin }) => {
    expect(
      shouldRetainLine(
        line({
          type: 'attachment',
          uuid: 'qc-1',
          attachment: { type: 'queued_command', origin, text: 'interrupt message' }
        })
      )
    ).toBe(true)
  })

  it.each(['compact_boundary', 'away_summary', 'turn_duration', 'informational'])(
    'retains system subtype=%s',
    (subtype) => {
      expect(shouldRetainLine(line({ type: 'system', uuid: 's1', subtype }))).toBe(true)
    }
  )
})

describe('shouldRetainLine — R-3 discarded shapes', () => {
  it('discards a user turn whose content is a tool_result block only', () => {
    expect(
      shouldRetainLine(
        line({
          type: 'user',
          uuid: 'u4',
          message: { content: [{ type: 'tool_result', content: 'stdout...' }] }
        })
      )
    ).toBe(false)
  })

  it.each([
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
  ])('discards attachment.type=%s', (attType) => {
    expect(
      shouldRetainLine(line({ type: 'attachment', uuid: 'x2', attachment: { type: attType } }))
    ).toBe(false)
  })

  it.each(['stop_hook_summary', 'local_command', 'scheduled_task_fire'])(
    'discards system subtype=%s',
    (subtype) => {
      expect(shouldRetainLine(line({ type: 'system', uuid: 's2', subtype }))).toBe(false)
    }
  )

  it.each([
    'mode',
    'permission-mode',
    'ai-title',
    'last-prompt',
    'pr-link',
    'queue-operation',
    'file-history-snapshot',
    'file-history-delta'
  ])('discards top-level type=%s', (type) => {
    expect(shouldRetainLine(line({ type }))).toBe(false)
  })
})

describe('shouldRetainLine — R-5 tolerant fallbacks (retain when uncertain)', () => {
  it('retains an unknown top-level type', () => {
    expect(shouldRetainLine(line({ type: 'some-future-type', uuid: 'z1' }))).toBe(true)
  })

  it('retains an attachment with an unknown attachment.type', () => {
    expect(
      shouldRetainLine(
        line({ type: 'attachment', uuid: 'z2', attachment: { type: 'future_kind' } })
      )
    ).toBe(true)
  })

  it('retains a system line with an unknown subtype', () => {
    expect(shouldRetainLine(line({ type: 'system', uuid: 'z3', subtype: 'future_subtype' }))).toBe(
      true
    )
  })

  it('retains an attachment line missing the attachment field entirely', () => {
    expect(shouldRetainLine(line({ type: 'attachment', uuid: 'z4' }))).toBe(true)
  })

  it('retains an attachment line whose attachment field is not an object', () => {
    expect(shouldRetainLine(line({ type: 'attachment', uuid: 'z5', attachment: 'oops' }))).toBe(
      true
    )
  })

  it('retains a system line missing subtype entirely', () => {
    expect(shouldRetainLine(line({ type: 'system', uuid: 'z6' }))).toBe(true)
  })

  it('retains malformed JSON', () => {
    expect(shouldRetainLine('{not valid json')).toBe(true)
  })

  it('retains a line whose top-level JSON value is not an object', () => {
    expect(shouldRetainLine(JSON.stringify(['array', 'not', 'object']))).toBe(true)
  })

  it('retains a user turn with unexpected (non-string/array) content shape', () => {
    expect(shouldRetainLine(line({ type: 'user', uuid: 'z7', message: { content: 42 } }))).toBe(
      true
    )
  })

  it('retains a user turn whose content array mixes tool_result with other block types', () => {
    expect(
      shouldRetainLine(
        line({
          type: 'user',
          uuid: 'z8',
          message: {
            content: [
              { type: 'tool_result', content: 'stdout' },
              { type: 'text', text: 'also this' }
            ]
          }
        })
      )
    ).toBe(true)
  })
})

describe('shouldRetainLine — blank lines', () => {
  it('does not retain an empty line', () => {
    expect(shouldRetainLine('')).toBe(false)
  })

  it('does not retain a whitespace-only line', () => {
    expect(shouldRetainLine('   \t  ')).toBe(false)
  })
})

describe('extractUuid', () => {
  it('extracts the uuid field of a valid line', () => {
    expect(extractUuid(line({ type: 'assistant', uuid: 'abc-123' }))).toBe('abc-123')
  })

  it('returns null when uuid is absent', () => {
    expect(extractUuid(line({ type: 'mode' }))).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(extractUuid('{not valid')).toBeNull()
  })

  it('returns null for a blank line', () => {
    expect(extractUuid('   ')).toBeNull()
  })

  it('returns null when uuid is not a string', () => {
    expect(extractUuid(line({ type: 'assistant', uuid: 42 }))).toBeNull()
  })
})

describe("lastRetainedUuid — C2 fix (matches readArchiveAnchor's backward skip-past-uuid-less-lines)", () => {
  it('returns the uuid of the last line when it carries one', () => {
    expect(lastRetainedUuid([line({ uuid: 'a' }), line({ uuid: 'b' })], null)).toBe('b')
  })

  it('skips backward past trailing uuid-less lines to find the last uuid that exists', () => {
    expect(lastRetainedUuid([line({ uuid: 'a' }), line({ type: 'some-future-type' })], null)).toBe(
      'a'
    )
  })

  it('falls back to the given fallback when none of the lines carry a uuid', () => {
    expect(lastRetainedUuid([line({ type: 'some-future-type' })], 'previous-uuid')).toBe(
      'previous-uuid'
    )
  })

  it('falls back to null when no fallback is given and none of the lines carry a uuid', () => {
    expect(lastRetainedUuid([line({ type: 'some-future-type' })], null)).toBeNull()
  })

  it('returns null for an empty line list with no fallback', () => {
    expect(lastRetainedUuid([], null)).toBeNull()
  })
})

describe('parseSidecar', () => {
  it('parses a valid sidecar payload', () => {
    expect(parseSidecar(JSON.stringify({ sourceOffset: 123, lastUuid: 'abc' }))).toEqual({
      sourceOffset: 123,
      lastUuid: 'abc'
    })
  })

  it('accepts a null lastUuid', () => {
    expect(parseSidecar(JSON.stringify({ sourceOffset: 0, lastUuid: null }))).toEqual({
      sourceOffset: 0,
      lastUuid: null
    })
  })

  it('throws (does not silently swallow) on malformed JSON', () => {
    expect(() => parseSidecar('{not valid json')).toThrow()
  })

  it('throws when sourceOffset is missing', () => {
    expect(() => parseSidecar(JSON.stringify({ lastUuid: 'abc' }))).toThrow()
  })

  it('throws when sourceOffset is negative', () => {
    expect(() => parseSidecar(JSON.stringify({ sourceOffset: -1, lastUuid: null }))).toThrow()
  })

  it('throws when lastUuid is present but not a string or null', () => {
    expect(() => parseSidecar(JSON.stringify({ sourceOffset: 0, lastUuid: 42 }))).toThrow()
  })

  it('throws when the payload is not an object', () => {
    expect(() => parseSidecar(JSON.stringify([1, 2, 3]))).toThrow()
  })
})

describe('decideResumeOffset — R-6 resume branches (B2 fix: archiveAnchor discriminated union)', () => {
  it('adopts sourceOffset when the sidecar exists and lastUuid matches the archive tail uuid', () => {
    expect(
      decideResumeOffset({
        sidecar: { sourceOffset: 500, lastUuid: 'match-uuid' },
        archiveAnchor: { kind: 'uuid', uuid: 'match-uuid' }
      })
    ).toEqual({ kind: 'sidecar', sourceOffset: 500 })
  })

  it('falls back to scanning by uuid when the sidecar exists but lastUuid does not match (crash window)', () => {
    expect(
      decideResumeOffset({
        sidecar: { sourceOffset: 500, lastUuid: 'stale-uuid' },
        archiveAnchor: { kind: 'uuid', uuid: 'newer-uuid' }
      })
    ).toEqual({ kind: 'scan', targetUuid: 'newer-uuid' })
  })

  // C1 fix: this used to short-circuit to `{ kind: 'legacyArchiveSize' }` (adopt the archive's own byte
  // size, unverified) on the unproven assumption that "no sidecar" always means "pre-M10 verbatim
  // archive". A post-M10, selectively-retained archive that merely lost its sidecar looks identical from
  // here (`sidecar: null`, `archiveAnchor.kind === 'uuid'`) but its size bears no relationship to any
  // source offset, so that assumption silently corrupted the next read. Falling back to `scan`
  // unconditionally is the fix: for a genuinely pre-M10 verbatim archive it lands on the exact same
  // offset (the anchor uuid still appears exactly once in the source), and for everything else it is the
  // only safe option.
  it('falls back to scanning by uuid when there is no sidecar, regardless of why (may be a lost sidecar, not necessarily a pre-M10 archive)', () => {
    expect(
      decideResumeOffset({
        sidecar: null,
        archiveAnchor: { kind: 'uuid', uuid: 'legacy-uuid' }
      })
    ).toEqual({ kind: 'scan', targetUuid: 'legacy-uuid' })
  })

  it('falls back to zero when there is no sidecar and no archive content (brand-new session)', () => {
    expect(
      decideResumeOffset({
        sidecar: null,
        archiveAnchor: { kind: 'empty' }
      })
    ).toEqual({ kind: 'zero' })
  })

  it('adopts the sidecar sourceOffset when the archive is empty but the sidecar records a null-uuid last line (source bytes read and fully discarded)', () => {
    expect(
      decideResumeOffset({
        sidecar: { sourceOffset: 0, lastUuid: null },
        archiveAnchor: { kind: 'empty' }
      })
    ).toEqual({ kind: 'sidecar', sourceOffset: 0 })
  })

  it('refuses (unsafe) when the archive is empty but the sidecar records a non-null lastUuid (contradiction)', () => {
    const result = decideResumeOffset({
      sidecar: { sourceOffset: 500, lastUuid: 'ghost-uuid' },
      archiveAnchor: { kind: 'empty' }
    })
    expect(result.kind).toBe('unsafe')
  })

  it('never returns zero for a non-empty archive with no sidecar and no uuid anywhere in it (B2: no silent full re-append)', () => {
    const result = decideResumeOffset({
      sidecar: null,
      archiveAnchor: { kind: 'noUuid' }
    })
    expect(result.kind).toBe('unsafe')
  })

  it('adopts the sidecar sourceOffset when the archive has content with no uuid anywhere and the sidecar agrees (null lastUuid)', () => {
    expect(
      decideResumeOffset({
        sidecar: { sourceOffset: 300, lastUuid: null },
        archiveAnchor: { kind: 'noUuid' }
      })
    ).toEqual({ kind: 'sidecar', sourceOffset: 300 })
  })

  it('refuses (unsafe) when the archive has content with no uuid anywhere but the sidecar disagrees (non-null lastUuid)', () => {
    const result = decideResumeOffset({
      sidecar: { sourceOffset: 300, lastUuid: 'some-uuid' },
      archiveAnchor: { kind: 'noUuid' }
    })
    expect(result.kind).toBe('unsafe')
  })
})

describe('reduction effectiveness (fixture modeled on the real 287MB/67,235-line measurement)', () => {
  // milestones/M10-archive-line-retention/plan.md §1's measured breakdown: the dominant noise is
  // attachment hook_success/async_hook_response, user tool_result, system stop_hook_summary, and small
  // per-turn duplicate bookkeeping rows; the useful signal is human text, assistant thinking/tool_use/
  // text, and rare rule-firing attachment types. This fixture mirrors that composition proportionally
  // (not the literal 287MB) so the assertion below stays fast while still exercising every discard/retain
  // category together, per acceptance.md's "削減効果の確認".
  function pad(length: number): string {
    return 'x'.repeat(length)
  }

  function buildFixtureLines(): string[] {
    const lines: string[] = []

    for (let i = 0; i < 50; i += 1) {
      lines.push(
        line({
          type: 'attachment',
          uuid: `hs-${i}`,
          attachment: { type: 'hook_success', payload: pad(2000) }
        })
      )
    }
    for (let i = 0; i < 20; i += 1) {
      lines.push(
        line({
          type: 'attachment',
          uuid: `ahr-${i}`,
          attachment: { type: 'async_hook_response', payload: pad(2000) }
        })
      )
    }
    for (let i = 0; i < 30; i += 1) {
      lines.push(
        line({
          type: 'user',
          uuid: `tr-${i}`,
          message: { content: [{ type: 'tool_result', content: pad(1000) }] }
        })
      )
    }
    for (let i = 0; i < 10; i += 1) {
      lines.push(
        line({ type: 'system', uuid: `shs-${i}`, subtype: 'stop_hook_summary', payload: pad(1500) })
      )
    }
    const perTurnDuplicateTypes = [
      'mode',
      'permission-mode',
      'ai-title',
      'last-prompt',
      'pr-link',
      'queue-operation',
      'file-history-snapshot',
      'file-history-delta'
    ]
    for (const type of perTurnDuplicateTypes) {
      for (let i = 0; i < 15; i += 1) {
        lines.push(line({ type, uuid: `${type}-${i}`, payload: pad(100) }))
      }
    }

    for (let i = 0; i < 10; i += 1) {
      lines.push(
        line({
          type: 'user',
          uuid: `human-${i}`,
          message: { content: [{ type: 'text', text: `human message ${i} ${pad(50)}` }] }
        })
      )
    }
    for (let i = 0; i < 15; i += 1) {
      lines.push(
        line({
          type: 'assistant',
          uuid: `asst-${i}`,
          message: {
            content: [
              { type: 'thinking', thinking: pad(200) },
              { type: 'tool_use', name: 'Bash', input: { command: pad(50) } },
              { type: 'text', text: pad(50) }
            ],
            usage: { input_tokens: 10, output_tokens: 5 }
          }
        })
      )
    }
    for (const attachmentType of ['hook_blocking_error', 'invoked_skills']) {
      lines.push(
        line({
          type: 'attachment',
          uuid: `${attachmentType}-1`,
          attachment: { type: attachmentType, payload: pad(100) }
        })
      )
    }

    return lines
  }

  it('retains less than 10% of the fixture bytes', () => {
    const fixtureLines = buildFixtureLines()
    const byteLengthWithNewline = (l: string): number => Buffer.byteLength(l, 'utf-8') + 1

    const totalBytes = fixtureLines.reduce((sum, l) => sum + byteLengthWithNewline(l), 0)
    const retainedBytes = fixtureLines
      .filter(shouldRetainLine)
      .reduce((sum, l) => sum + byteLengthWithNewline(l), 0)

    expect(retainedBytes / totalBytes).toBeLessThan(0.1)
  })
})
