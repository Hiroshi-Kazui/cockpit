// Evaluation dashboard (M9, R-4): weekly/monthly axis-average trend + all-time overall summary. Rendered
// as an overlay sibling of PaneGrid in App.tsx, same mounting convention as SessionBrowser.tsx/
// ArchiveOutputSettings.tsx. All bucketing/averaging is done by shared/evaluationAggregate.ts's pure
// functions -- this component only fetches the raw history once (+ refreshes on every evaluationUpdated
// push, so a fresh completion/rerun is reflected without needing to reopen the dialog) and renders it.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { EvaluationHistoryEntry } from '@shared/ipc'
import {
  bucketEvaluationsMonthly,
  bucketEvaluationsWeekly,
  computeOverallEvaluationSummary
} from '@shared/evaluationAggregate'
import { EvaluationLineChart, type EvaluationLineSeries } from './EvaluationLineChart'

interface EvaluationDashboardProps {
  onClose: () => void
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const FOCUSABLE_SELECTOR = 'button:not(:disabled)'

/** Local timezone offset in the convention shared/evaluationAggregate.ts's pure functions expect (local
 * time's offset *ahead of* UTC) -- the mirror image of `Date.prototype.getTimezoneOffset()`. */
function localTzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset()
}

const SERIES_COLORS = { smoothness: '#4ec9b0', stress: '#f48771', commCost: '#dcdcaa' }

export function EvaluationDashboard({ onClose }: EvaluationDashboardProps): React.JSX.Element {
  const [history, setHistory] = useState<EvaluationHistoryEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [granularity, setGranularity] = useState<'weekly' | 'monthly'>('weekly')
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    function load(): void {
      window.cockpit.evaluation
        .listAll()
        .then((entries) => {
          if (!cancelled) setHistory(entries)
        })
        .catch((err: unknown) => {
          if (!cancelled) setLoadError(describeError(err))
        })
    }
    load()
    const unsubscribe = window.cockpit.evaluation.onUpdated(() => load())
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const tzOffsetMinutes = useMemo(localTzOffsetMinutes, [])
  const buckets = useMemo(() => {
    if (!history) return []
    return granularity === 'weekly'
      ? bucketEvaluationsWeekly(history, tzOffsetMinutes)
      : bucketEvaluationsMonthly(history, tzOffsetMinutes)
  }, [history, granularity, tzOffsetMinutes])

  const overall = useMemo(() => computeOverallEvaluationSummary(history ?? []), [history])

  const series: EvaluationLineSeries[] = [
    {
      key: 'smoothness',
      label: '順調度',
      color: SERIES_COLORS.smoothness,
      values: buckets.map((b) => b.averages.smoothness)
    },
    {
      key: 'stress',
      label: 'ストレス度（高いほど悪い）',
      color: SERIES_COLORS.stress,
      values: buckets.map((b) => b.averages.stress)
    },
    {
      key: 'commCost',
      label: 'コミュニケーションコスト（高いほど悪い）',
      color: SERIES_COLORS.commCost,
      values: buckets.map((b) => b.averages.commCost)
    }
  ]

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const container = dialogRef.current
    if (!container) return
    const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="dialog-backdrop evaluation-dashboard-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="evaluation-dashboard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evaluation-dashboard-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="evaluation-dashboard__header">
          <h3 id="evaluation-dashboard-title">評価ダッシュボード</h3>
          <button type="button" onClick={onClose} aria-label="閉じる" autoFocus>
            ✕
          </button>
        </div>
        <div className="evaluation-dashboard__body">
          {loadError && (
            <div className="evaluation-dashboard__error" role="alert">
              読み込みに失敗しました: {loadError}
            </div>
          )}

          <p className="evaluation-dashboard__disclaimer">
            各評価はLLMによる主観的な単発判定であり、個々のスコアの精度は保証されません。傾向（変化の向き）の把握を目的とした指標です。
          </p>

          <div className="evaluation-dashboard__overall">
            <h4>全期間の総合評価</h4>
            {overall.count === 0 || overall.averages === null ? (
              <p className="evaluation-dashboard__hint">まだ評価データがありません（{overall.count}件）</p>
            ) : (
              <p>
                評価件数: {overall.count}件 / 順調度平均: {overall.averages.smoothness} / ストレス度平均:{' '}
                {overall.averages.stress}（高いほど悪い）/ コミュニケーションコスト平均:{' '}
                {overall.averages.commCost}（高いほど悪い）
              </p>
            )}
          </div>

          <div className="evaluation-dashboard__granularity">
            <button
              type="button"
              className={granularity === 'weekly' ? 'active' : ''}
              onClick={() => setGranularity('weekly')}
            >
              週次
            </button>
            <button
              type="button"
              className={granularity === 'monthly' ? 'active' : ''}
              onClick={() => setGranularity('monthly')}
            >
              月次
            </button>
          </div>

          <EvaluationLineChart
            points={buckets.map((b) => ({ key: b.key, label: b.label, timeMs: b.startMs }))}
            series={series}
          />

          <ul className="evaluation-dashboard__legend">
            {series.map((s) => (
              <li key={s.key}>
                <span className="evaluation-dashboard__legend-swatch" style={{ background: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
