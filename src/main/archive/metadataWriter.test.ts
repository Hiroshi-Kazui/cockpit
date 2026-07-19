// Unit test for the pure metadata-shaping helper (spec §4.4) and the debounced writer (M2 FIX major
// #3: avoid a synchronous writeFileSync on every statusLine-triggered update). writeSessionMetadata
// itself is a thin fs.writeFileSync wrapper and is exercised indirectly via archiver.test.ts-style
// manual verification.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '../../shared/ipc'
import { createDebouncedMetadataWriter, toMetadata } from './metadataWriter'

function baseSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    pane: 0,
    purposeId: 'purpose-1',
    origin: 'dialog',
    purpose: 'refactor the parser',
    title: 'Parser refactor',
    cwd: 'C:\\work\\repo',
    startedAt: 1000,
    endedAt: null,
    model: 'claude-sonnet-4-5',
    tokensIn: 10,
    tokensOut: 20,
    tokensCacheRead: 5,
    tokensCacheWrite: 2,
    ...overrides
  }
}

describe('toMetadata', () => {
  it('maps a SessionSummary to the on-disk metadata shape (spec §4.4 fields)', () => {
    expect(toMetadata(baseSummary())).toEqual({
      sessionId: 'sess-1',
      pane: 0,
      purpose: 'refactor the parser',
      title: 'Parser refactor',
      cwd: 'C:\\work\\repo',
      startedAt: 1000,
      endedAt: null,
      model: 'claude-sonnet-4-5',
      tokens: { in: 10, out: 20, cacheRead: 5, cacheWrite: 2 }
    })
  })

  it('carries endedAt through once a session is closed', () => {
    const result = toMetadata(baseSummary({ endedAt: 5000 }))
    expect(result.endedAt).toBe(5000)
  })

  it('handles a session with no linked purpose (purpose_id NULL, spec §5)', () => {
    const result = toMetadata(baseSummary({ purposeId: null, purpose: null, title: null }))
    expect(result.purpose).toBeNull()
    expect(result.title).toBeNull()
  })
})

describe('createDebouncedMetadataWriter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces rapid repeated schedule() calls for the same session into a single write after delayMs', () => {
    const write = vi.fn()
    const writer = createDebouncedMetadataWriter(500, write)

    writer.schedule('/archive/s1', baseSummary({ tokensIn: 1 }))
    writer.schedule('/archive/s1', baseSummary({ tokensIn: 2 }))
    writer.schedule('/archive/s1', baseSummary({ tokensIn: 3 }))

    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('/archive/s1', expect.objectContaining({ tokensIn: 3 }))
  })

  it('debounces independently per session id', () => {
    const write = vi.fn()
    const writer = createDebouncedMetadataWriter(500, write)

    writer.schedule('/archive/s1', baseSummary({ id: 's1' }))
    writer.schedule('/archive/s2', baseSummary({ id: 's2' }))
    vi.advanceTimersByTime(500)

    expect(write).toHaveBeenCalledTimes(2)
  })

  it('writes immediately (bypassing the debounce) once the session has endedAt set', () => {
    const write = vi.fn()
    const writer = createDebouncedMetadataWriter(500, write)

    writer.schedule('/archive/s1', baseSummary({ endedAt: 9999 }))

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('/archive/s1', expect.objectContaining({ endedAt: 9999 }))
  })

  it('cancels a pending debounced write when the session closes before the delay elapses', () => {
    const write = vi.fn()
    const writer = createDebouncedMetadataWriter(500, write)

    writer.schedule('/archive/s1', baseSummary({ endedAt: null, tokensIn: 1 }))
    writer.schedule('/archive/s1', baseSummary({ endedAt: 9999, tokensIn: 2 }))
    vi.advanceTimersByTime(500)

    // Only the immediate close-time write happened; the earlier pending debounce never separately fires.
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('/archive/s1', expect.objectContaining({ endedAt: 9999 }))
  })

  it('flush() immediately performs and cancels a pending write for one session', () => {
    const write = vi.fn()
    const writer = createDebouncedMetadataWriter(500, write)

    writer.schedule('/archive/s1', baseSummary({ id: 's1' }))
    writer.flush('s1')
    vi.advanceTimersByTime(500)

    expect(write).toHaveBeenCalledTimes(1)
  })

  it('flush() on a session with no pending write is a no-op', () => {
    const write = vi.fn()
    const writer = createDebouncedMetadataWriter(500, write)

    expect(() => writer.flush('unknown')).not.toThrow()
    expect(write).not.toHaveBeenCalled()
  })

  it('flushAll() immediately performs every pending write (e.g. app quit)', () => {
    const write = vi.fn()
    const writer = createDebouncedMetadataWriter(500, write)

    writer.schedule('/archive/s1', baseSummary({ id: 's1' }))
    writer.schedule('/archive/s2', baseSummary({ id: 's2' }))
    writer.flushAll()

    expect(write).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(500)
    // No double-write once the original timer would have fired.
    expect(write).toHaveBeenCalledTimes(2)
  })
})
