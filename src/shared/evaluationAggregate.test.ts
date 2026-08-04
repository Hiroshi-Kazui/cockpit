import { describe, expect, it } from 'vitest'
import {
  bucketEvaluationsMonthly,
  bucketEvaluationsWeekly,
  computeOverallEvaluationSummary,
  type EvaluationHistoryEntry
} from './evaluationAggregate'

function entry(partial: Partial<EvaluationHistoryEntry> & { id: string; createdAt: number }): EvaluationHistoryEntry {
  return {
    purposeId: 'p1',
    status: 'ok',
    smoothness: 80,
    stress: 20,
    commCost: 10,
    ...partial
  }
}

const UTC = 0

describe('computeOverallEvaluationSummary', () => {
  it('returns count 0 and null averages when there are no entries', () => {
    const result = computeOverallEvaluationSummary([])
    expect(result).toEqual({ count: 0, averages: null })
  })

  it('excludes skipped/error/pending rows from the count and averages', () => {
    const entries: EvaluationHistoryEntry[] = [
      entry({ id: '1', createdAt: 1000, status: 'ok', smoothness: 100, stress: 0, commCost: 0 }),
      entry({ id: '2', createdAt: 2000, status: 'skipped', smoothness: null, stress: null, commCost: null }),
      entry({ id: '3', createdAt: 3000, status: 'error', smoothness: null, stress: null, commCost: null }),
      entry({ id: '4', createdAt: 4000, status: 'pending', smoothness: null, stress: null, commCost: null })
    ]
    const result = computeOverallEvaluationSummary(entries)
    expect(result.count).toBe(1)
    expect(result.averages).toEqual({ smoothness: 100, stress: 0, commCost: 0 })
  })

  it('averages multiple ok rows correctly', () => {
    const entries: EvaluationHistoryEntry[] = [
      entry({ id: '1', createdAt: 1000, smoothness: 80, stress: 20, commCost: 10 }),
      entry({ id: '2', createdAt: 2000, smoothness: 60, stress: 40, commCost: 30 })
    ]
    const result = computeOverallEvaluationSummary(entries)
    expect(result.count).toBe(2)
    expect(result.averages).toEqual({ smoothness: 70, stress: 30, commCost: 20 })
  })
})

describe('bucketEvaluationsWeekly (ISO week, Monday start, local time)', () => {
  it('buckets a single Wednesday entry into its containing Mon-Sun week', () => {
    // 2026-07-22 is a Wednesday. Its ISO week starts Monday 2026-07-20 00:00 UTC.
    const createdAt = Date.UTC(2026, 6, 22, 12, 0, 0)
    const entries = [entry({ id: '1', createdAt })]
    const buckets = bucketEvaluationsWeekly(entries, UTC)
    expect(buckets).toHaveLength(1)
    expect(buckets[0].count).toBe(1)
    expect(buckets[0].startMs).toBe(Date.UTC(2026, 6, 20, 0, 0, 0))
    expect(buckets[0].endMs).toBe(Date.UTC(2026, 6, 27, 0, 0, 0))
  })

  it('splits entries either side of a week boundary (Sun 23:59 vs Mon 00:00) into different buckets', () => {
    const sundayEnd = Date.UTC(2026, 6, 19, 23, 59, 0) // Sunday, last week
    const mondayStart = Date.UTC(2026, 6, 20, 0, 0, 0) // Monday, next week
    const entries = [
      entry({ id: '1', createdAt: sundayEnd }),
      entry({ id: '2', createdAt: mondayStart })
    ]
    const buckets = bucketEvaluationsWeekly(entries, UTC)
    expect(buckets).toHaveLength(2)
    expect(buckets[0].count).toBe(1)
    expect(buckets[1].count).toBe(1)
    expect(buckets[0].startMs).toBeLessThan(buckets[1].startMs)
  })

  it('handles a year boundary correctly (ISO week can belong to the adjoining year)', () => {
    // 2025-12-29 (Mon) .. 2026-01-04 (Sun) is ISO week 1 of 2026 even though it spans into Dec 2025.
    const dec29 = Date.UTC(2025, 11, 29, 6, 0, 0)
    const jan1 = Date.UTC(2026, 0, 1, 6, 0, 0)
    const buckets = bucketEvaluationsWeekly(
      [entry({ id: '1', createdAt: dec29 }), entry({ id: '2', createdAt: jan1 })],
      UTC
    )
    expect(buckets).toHaveLength(1)
    expect(buckets[0].count).toBe(2)
    expect(buckets[0].key).toBe('2026-W01')
  })

  it('excludes non-ok rows and sorts buckets ascending by start time', () => {
    const week1 = Date.UTC(2026, 6, 22)
    const week2 = Date.UTC(2026, 6, 29)
    const entries = [
      entry({ id: '2', createdAt: week2 }),
      entry({ id: '1', createdAt: week1 }),
      entry({ id: '3', createdAt: week1, status: 'skipped', smoothness: null, stress: null, commCost: null })
    ]
    const buckets = bucketEvaluationsWeekly(entries, UTC)
    expect(buckets).toHaveLength(2)
    expect(buckets[0].startMs).toBeLessThan(buckets[1].startMs)
    expect(buckets[0].count).toBe(1) // the 'skipped' row in the same week is excluded
  })

  it('respects a nonzero (negative, "behind UTC") local timezone offset when deciding the week', () => {
    // 2026-07-20 04:00 UTC (Monday) is 2026-07-19 20:00 in UTC-8 (e.g. US Pacific standard time) --
    // still Sunday, i.e. the *previous* ISO week (2026-W29, not 2026-W30) once converted to local time.
    const createdAt = Date.UTC(2026, 6, 20, 4, 0, 0)
    const pacificOffsetMinutes = -8 * 60
    const buckets = bucketEvaluationsWeekly([entry({ id: '1', createdAt })], pacificOffsetMinutes)
    expect(buckets).toHaveLength(1)
    expect(buckets[0].key).toBe('2026-W29')
  })
})

describe('bucketEvaluationsMonthly (calendar month, local time)', () => {
  it('buckets entries within the same month together', () => {
    const entries = [
      entry({ id: '1', createdAt: Date.UTC(2026, 6, 1) }),
      entry({ id: '2', createdAt: Date.UTC(2026, 6, 31, 23, 0) })
    ]
    const buckets = bucketEvaluationsMonthly(entries, UTC)
    expect(buckets).toHaveLength(1)
    expect(buckets[0].count).toBe(2)
    expect(buckets[0].key).toBe('2026-07')
    expect(buckets[0].startMs).toBe(Date.UTC(2026, 6, 1))
    expect(buckets[0].endMs).toBe(Date.UTC(2026, 7, 1))
  })

  it('splits entries either side of a month boundary', () => {
    const entries = [
      entry({ id: '1', createdAt: Date.UTC(2026, 6, 31, 23, 59) }),
      entry({ id: '2', createdAt: Date.UTC(2026, 7, 1, 0, 0) })
    ]
    const buckets = bucketEvaluationsMonthly(entries, UTC)
    expect(buckets).toHaveLength(2)
    expect(buckets[0].key).toBe('2026-07')
    expect(buckets[1].key).toBe('2026-08')
  })

  it('handles a year boundary (December -> January)', () => {
    const entries = [
      entry({ id: '1', createdAt: Date.UTC(2025, 11, 15) }),
      entry({ id: '2', createdAt: Date.UTC(2026, 0, 15) })
    ]
    const buckets = bucketEvaluationsMonthly(entries, UTC)
    expect(buckets.map((b) => b.key)).toEqual(['2025-12', '2026-01'])
  })

  it('averages axis values within each monthly bucket', () => {
    const entries = [
      entry({ id: '1', createdAt: Date.UTC(2026, 6, 1), smoothness: 100, stress: 0, commCost: 0 }),
      entry({ id: '2', createdAt: Date.UTC(2026, 6, 15), smoothness: 0, stress: 100, commCost: 100 })
    ]
    const buckets = bucketEvaluationsMonthly(entries, UTC)
    expect(buckets[0].averages).toEqual({ smoothness: 50, stress: 50, commCost: 50 })
  })
})
