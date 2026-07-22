// Pure weekly/monthly/overall aggregation over purpose-evaluation history (spec §4 evaluation dashboard,
// ADR-0010 D-6): week = ISO week (Monday start), month = calendar month, both computed against a
// caller-supplied local timezone offset (never the host's own TZ) so this stays fully deterministic and
// unit-testable across week/month/year boundaries regardless of where/when the test runner executes.
// `status !== 'ok'` rows (pending/error/skipped) are excluded from every aggregate here -- R-4 "skipped/
// error の評価行は集計から除外される".
export interface EvaluationHistoryEntry {
  id: string
  purposeId: string
  createdAt: number
  status: 'pending' | 'ok' | 'error' | 'skipped'
  smoothness: number | null
  stress: number | null
  commCost: number | null
}

export interface EvaluationAxisAverages {
  smoothness: number
  stress: number
  commCost: number
}

export interface EvaluationBucket {
  /** Stable, sortable identifier: `YYYY-Www` for weekly buckets, `YYYY-MM` for monthly. */
  key: string
  /** Short Japanese label for display. */
  label: string
  /** Bucket boundaries in true UTC epoch ms (startMs inclusive, endMs exclusive). */
  startMs: number
  endMs: number
  count: number
  averages: EvaluationAxisAverages
}

export interface EvaluationOverallSummary {
  count: number
  averages: EvaluationAxisAverages | null
}

const MS_PER_DAY = 86_400_000

interface ScoredEntry {
  createdAt: number
  smoothness: number
  stress: number
  commCost: number
}

/** Only 'ok' rows carry meaningful (non-null) scores in practice, but the null-check here is the actual
 * source of truth for "is this usable for aggregation" -- defense-in-depth against a status/score
 * mismatch rather than trusting `status` alone. */
function onlyScoredOkEntries(entries: readonly EvaluationHistoryEntry[]): ScoredEntry[] {
  const result: ScoredEntry[] = []
  for (const entry of entries) {
    if (entry.status !== 'ok') continue
    if (entry.smoothness === null || entry.stress === null || entry.commCost === null) continue
    result.push({
      createdAt: entry.createdAt,
      smoothness: entry.smoothness,
      stress: entry.stress,
      commCost: entry.commCost
    })
  }
  return result
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function averageAxes(entries: readonly ScoredEntry[]): EvaluationAxisAverages {
  const count = entries.length
  const sum = entries.reduce(
    (acc, e) => ({
      smoothness: acc.smoothness + e.smoothness,
      stress: acc.stress + e.stress,
      commCost: acc.commCost + e.commCost
    }),
    { smoothness: 0, stress: 0, commCost: 0 }
  )
  return {
    smoothness: round1(sum.smoothness / count),
    stress: round1(sum.stress / count),
    commCost: round1(sum.commCost / count)
  }
}

/** All-period totals: axis averages + evaluation count across every 'ok' row, regardless of bucket. */
export function computeOverallEvaluationSummary(
  entries: readonly EvaluationHistoryEntry[]
): EvaluationOverallSummary {
  const scored = onlyScoredOkEntries(entries)
  if (scored.length === 0) return { count: 0, averages: null }
  return { count: scored.length, averages: averageAxes(scored) }
}

/** Shifts a true UTC epoch ms into a "fake UTC" epoch ms whose UTC-getter components (getUTCFullYear,
 * getUTCMonth, getUTCDate, getUTCDay, ...) read as the *local* wall-clock date/time at `tzOffsetMinutes`
 * -- the standard trick for doing local-calendar arithmetic without ever depending on the host process's
 * own timezone. Convention: `tzOffsetMinutes` is local time's offset *ahead of* UTC (e.g. JST = +540,
 * US Pacific standard time = -480) -- the mirror image of `Date.prototype.getTimezoneOffset()`. */
function toLocalWallClockMs(utcMs: number, tzOffsetMinutes: number): number {
  return utcMs + tzOffsetMinutes * 60_000
}

function fromLocalWallClockMs(localWallMs: number, tzOffsetMinutes: number): number {
  return localWallMs - tzOffsetMinutes * 60_000
}

interface IsoWeekInfo {
  isoYear: number
  isoWeek: number
  /** Monday 00:00 of this ISO week, in the same "fake UTC local wall-clock" frame as the input. */
  mondayLocalWallMs: number
}

/** Standard ISO-8601 week algorithm (Monday start, week 1 = the week containing the year's first
 * Thursday), computed entirely via UTC getters on an already-local-shifted timestamp (see
 * `toLocalWallClockMs`) so it never touches the host's own timezone. */
function isoWeekInfo(localWallMs: number): IsoWeekInfo {
  const d = new Date(localWallMs)
  const dayOfWeek = (d.getUTCDay() + 6) % 7 // Monday=0 .. Sunday=6
  const mondayLocalWallMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dayOfWeek * MS_PER_DAY
  const thursdayLocalWallMs = mondayLocalWallMs + 3 * MS_PER_DAY
  const isoYear = new Date(thursdayLocalWallMs).getUTCFullYear()

  const jan4LocalWallMs = Date.UTC(isoYear, 0, 4)
  const jan4DayOfWeek = (new Date(jan4LocalWallMs).getUTCDay() + 6) % 7
  const week1MondayLocalWallMs = jan4LocalWallMs - jan4DayOfWeek * MS_PER_DAY
  const isoWeek = Math.round((mondayLocalWallMs - week1MondayLocalWallMs) / (7 * MS_PER_DAY)) + 1

  return { isoYear, isoWeek, mondayLocalWallMs }
}

function bucketKeyFor(entries: readonly ScoredEntry[], keyOf: (e: ScoredEntry) => string): Map<string, ScoredEntry[]> {
  const map = new Map<string, ScoredEntry[]>()
  for (const entry of entries) {
    const key = keyOf(entry)
    const group = map.get(key)
    if (group) group.push(entry)
    else map.set(key, [entry])
  }
  return map
}

/** ADR-0010 D-6: buckets 'ok' evaluation history into ISO weeks (Monday-start, local time per
 * `tzOffsetMinutes`), averaging each axis within the bucket. Only buckets containing at least one entry
 * are returned, sorted ascending by `startMs`. */
export function bucketEvaluationsWeekly(
  entries: readonly EvaluationHistoryEntry[],
  tzOffsetMinutes: number
): EvaluationBucket[] {
  const scored = onlyScoredOkEntries(entries)
  const grouped = bucketKeyFor(scored, (e) => {
    const { isoYear, isoWeek } = isoWeekInfo(toLocalWallClockMs(e.createdAt, tzOffsetMinutes))
    return `${isoYear}-W${String(isoWeek).padStart(2, '0')}`
  })

  const buckets: EvaluationBucket[] = []
  for (const [key, group] of grouped) {
    const { isoYear, isoWeek, mondayLocalWallMs } = isoWeekInfo(
      toLocalWallClockMs(group[0].createdAt, tzOffsetMinutes)
    )
    const startMs = fromLocalWallClockMs(mondayLocalWallMs, tzOffsetMinutes)
    const endMs = startMs + 7 * MS_PER_DAY
    buckets.push({
      key,
      label: `${isoYear}年 第${isoWeek}週`,
      startMs,
      endMs,
      count: group.length,
      averages: averageAxes(group)
    })
  }
  return buckets.sort((a, b) => a.startMs - b.startMs)
}

/** ADR-0010 D-6: buckets 'ok' evaluation history into calendar months (local time per
 * `tzOffsetMinutes`), averaging each axis within the bucket. Only buckets containing at least one entry
 * are returned, sorted ascending by `startMs`. */
export function bucketEvaluationsMonthly(
  entries: readonly EvaluationHistoryEntry[],
  tzOffsetMinutes: number
): EvaluationBucket[] {
  const scored = onlyScoredOkEntries(entries)
  const grouped = bucketKeyFor(scored, (e) => {
    const local = new Date(toLocalWallClockMs(e.createdAt, tzOffsetMinutes))
    return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`
  })

  const buckets: EvaluationBucket[] = []
  for (const [key, group] of grouped) {
    const local = new Date(toLocalWallClockMs(group[0].createdAt, tzOffsetMinutes))
    const year = local.getUTCFullYear()
    const month = local.getUTCMonth()
    const startMs = fromLocalWallClockMs(Date.UTC(year, month, 1), tzOffsetMinutes)
    const endMs = fromLocalWallClockMs(Date.UTC(year, month + 1, 1), tzOffsetMinutes)
    buckets.push({
      key,
      label: `${year}年${month + 1}月`,
      startMs,
      endMs,
      count: group.length,
      averages: averageAxes(group)
    })
  }
  return buckets.sort((a, b) => a.startMs - b.startMs)
}
