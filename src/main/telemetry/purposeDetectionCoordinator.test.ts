// Behavioral tests for PurposeDetectionCoordinator (spec §4.2 "目的が空で開始した場合") using
// fully in-memory fakes -- matches sessionCoordinator.test.ts/purposeCoordinator.test.ts's style.
import { describe, expect, it } from 'vitest'
import { PurposeDetectionCoordinator } from './purposeDetectionCoordinator'
import type { ParsedJsonlEntry } from '../../shared/jsonl'

function entry(userText: string | null, isUserTurnMissingHumanOrigin = false): ParsedJsonlEntry {
  return { timestampMs: null, model: null, usage: null, userText, isUserTurnMissingHumanOrigin }
}

interface Harness {
  coordinator: PurposeDetectionCoordinator
  decided: Array<{ purposeId: string; text: string }>
  warnings: string[]
}

function setup(getPendingPurposeId: (sessionId: string) => string | null): Harness {
  const decided: Array<{ purposeId: string; text: string }> = []
  const warnings: string[] = []
  const coordinator = new PurposeDetectionCoordinator({
    getPendingPurposeId,
    onPurposeDecided: (purposeId, text) => decided.push({ purposeId, text }),
    warn: (message) => warnings.push(message)
  })
  return { coordinator, decided, warnings }
}

describe('PurposeDetectionCoordinator.onJsonlEntries', () => {
  it('does nothing when the session has no pending purpose', () => {
    const h = setup(() => null)
    h.coordinator.onJsonlEntries('session-1', [entry('fix the bug')])
    expect(h.decided).toEqual([])
  })

  it('does nothing when the batch has no qualifying candidate yet', () => {
    const h = setup(() => 'purpose-1')
    h.coordinator.onJsonlEntries('session-1', [entry('/model fable'), entry(null)])
    expect(h.decided).toEqual([])
  })

  it('decides the pending purpose from the first non-command human message', () => {
    const h = setup(() => 'purpose-1')
    h.coordinator.onJsonlEntries('session-1', [entry('/model fable'), entry('fix the login bug')])
    expect(h.decided).toEqual([{ purposeId: 'purpose-1', text: 'fix the login bug' }])
  })

  it('looks up pending-ness per sessionId (continuation across /clear under the same purpose, TD-2)', () => {
    const purposeBySession = new Map<string, string | null>([
      ['session-1', 'purpose-1'],
      ['session-2', 'purpose-1']
    ])
    const h = setup((sessionId) => purposeBySession.get(sessionId) ?? null)

    // Session 1 never gets a real message (user only ran /clear); still pending.
    h.coordinator.onJsonlEntries('session-1', [entry('/clear')])
    expect(h.decided).toEqual([])

    // Session 2 (post-/clear, same active purpose) gets the first real message.
    h.coordinator.onJsonlEntries('session-2', [entry('actually do the thing')])
    expect(h.decided).toEqual([{ purposeId: 'purpose-1', text: 'actually do the thing' }])
  })

  it('does not re-decide once the store reports the purpose is no longer pending (already decided or completed)', () => {
    let pending: string | null = 'purpose-1'
    const h = setup(() => pending)

    h.coordinator.onJsonlEntries('session-1', [entry('first real message')])
    expect(h.decided).toEqual([{ purposeId: 'purpose-1', text: 'first real message' }])

    // Simulate the store now reflecting the decision (or a "完了" in the meantime).
    pending = null
    h.coordinator.onJsonlEntries('session-1', [entry('a later stray message')])
    expect(h.decided).toEqual([{ purposeId: 'purpose-1', text: 'first real message' }])
  })
})

// FIX (minor, origin-drift diagnostic -- purity pass): shared/jsonl.ts's parser is pure (it only reports
// `isUserTurnMissingHumanOrigin` as data); this coordinator is the impure consumer that tallies occurrences
// and emits the low-frequency diagnostic via the injected `warn` sink (see file header).
describe('PurposeDetectionCoordinator origin-drift diagnostic', () => {
  it('does not warn when no entry in the batch is missing human origin', () => {
    const h = setup(() => null)
    h.coordinator.onJsonlEntries('session-1', [entry('fix the bug', false)])
    expect(h.warnings).toEqual([])
  })

  it('warns on the very first occurrence of a missing-human-origin entry', () => {
    const h = setup(() => null)
    h.coordinator.onJsonlEntries('session-1', [entry(null, true)])
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toContain('occurrence #1')
  })

  it('does not warn again for occurrences 2..199, then samples every 200th (shared across batches)', () => {
    const h = setup(() => null)
    for (let i = 0; i < 199; i++) {
      h.coordinator.onJsonlEntries('session-1', [entry(null, true)])
    }
    // Occurrence #1 warned, #2..#199 did not.
    expect(h.warnings).toHaveLength(1)

    h.coordinator.onJsonlEntries('session-1', [entry(null, true)])
    // Occurrence #200 warns.
    expect(h.warnings).toHaveLength(2)
    expect(h.warnings[1]).toContain('occurrence #200')
  })

  it('counts drift diagnostics independently of purpose-detection outcome (fires even with no pending purpose)', () => {
    const h = setup(() => null)
    h.coordinator.onJsonlEntries('session-1', [entry('/model fable'), entry(null, true)])
    expect(h.decided).toEqual([])
    expect(h.warnings).toHaveLength(1)
  })
})
