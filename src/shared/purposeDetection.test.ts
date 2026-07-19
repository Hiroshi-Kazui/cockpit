// Unit tests for the pure "first non-command human message" purpose-detection logic (spec §4.2).
import { describe, expect, it } from 'vitest'
import { findFirstPurposeCandidate, isSlashOrSkillInvocation } from './purposeDetection'
import type { ParsedJsonlEntry } from './jsonl'

function entry(userText: string | null): ParsedJsonlEntry {
  return {
    timestampMs: null,
    model: null,
    usage: null,
    userText,
    isUserTurnMissingHumanOrigin: false
  }
}

describe('isSlashOrSkillInvocation', () => {
  it('treats a leading slash as a command/skill invocation', () => {
    expect(isSlashOrSkillInvocation('/model fable')).toBe(true)
    expect(isSlashOrSkillInvocation('/cockpit-build M4')).toBe(true)
  })

  it('trims before checking, so leading whitespace does not evade the check', () => {
    expect(isSlashOrSkillInvocation('   /clear')).toBe(true)
  })

  it('is false for ordinary text, including text that merely mentions a slash mid-sentence', () => {
    expect(isSlashOrSkillInvocation('fix the bug')).toBe(false)
    expect(isSlashOrSkillInvocation('run it with /cockpit-build M1 afterwards')).toBe(false)
  })
})

describe('findFirstPurposeCandidate', () => {
  it('returns null for an empty entry list', () => {
    expect(findFirstPurposeCandidate([])).toBeNull()
  })

  it('skips entries with no userText (assistant turns, tool results, etc.)', () => {
    const entries = [entry(null), entry(null), entry('fix the login bug')]
    expect(findFirstPurposeCandidate(entries)).toBe('fix the login bug')
  })

  it('skips a leading slash command and picks the next real message', () => {
    const entries = [entry('/model fable'), entry('READMEにセットアップ手順を追記して')]
    expect(findFirstPurposeCandidate(entries)).toBe('READMEにセットアップ手順を追記して')
  })

  it('skips empty and whitespace-only userText', () => {
    const entries = [entry(''), entry('   '), entry('\n\n'), entry('actual purpose text')]
    expect(findFirstPurposeCandidate(entries)).toBe('actual purpose text')
  })

  it('returns null when every entry is a command or empty (no candidate yet)', () => {
    const entries = [entry('/model fable'), entry(''), entry(null)]
    expect(findFirstPurposeCandidate(entries)).toBeNull()
  })

  it('trims the returned candidate text', () => {
    const entries = [entry('  fix the bug  ')]
    expect(findFirstPurposeCandidate(entries)).toBe('fix the bug')
  })

  it('picks the first qualifying entry, not the last, when multiple real messages are present', () => {
    const entries = [entry('first message'), entry('second message')]
    expect(findFirstPurposeCandidate(entries)).toBe('first message')
  })

  it('multi-line messages are accepted as-is (only leading/trailing trimmed)', () => {
    const entries = [entry('line one\nline two')]
    expect(findFirstPurposeCandidate(entries)).toBe('line one\nline two')
  })
})
