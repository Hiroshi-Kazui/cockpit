// Unit test for the pure TD-3 "last observed activity time" crash-recovery rule. The rest of
// sessionRepo.ts is a thin better-sqlite3 wrapper exercised indirectly via sessionCoordinator.test.ts's
// fake SessionStore (real better-sqlite3 cannot load under plain Node/vitest -- its native binary is
// rebuilt for Electron's ABI, verified empirically: NODE_MODULE_VERSION 130 vs required 137).
import { describe, expect, it } from 'vitest'
import { computeRepairEndedAt } from './sessionRepo'

describe('computeRepairEndedAt', () => {
  it('uses the archived transcript mtime when it is at or after started_at', () => {
    expect(computeRepairEndedAt(1000, 5000)).toBe(5000)
    expect(computeRepairEndedAt(1000, 1000)).toBe(1000)
  })

  it('rounds a fractional mtime (fs mtimeMs can be sub-millisecond precision)', () => {
    expect(computeRepairEndedAt(1000, 5000.7)).toBe(5001)
  })

  it('falls back to started_at when no archived file mtime is available (never archived)', () => {
    expect(computeRepairEndedAt(1000, null)).toBe(1000)
  })

  it('falls back to started_at when the mtime is implausibly before started_at (stale/foreign file)', () => {
    expect(computeRepairEndedAt(5000, 1000)).toBe(5000)
  })
})
