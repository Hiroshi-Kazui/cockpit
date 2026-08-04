// Pure SVG line chart, hand-rolled (D-7: no chart-library dependency added) for the M9 evaluation
// dashboard's weekly/monthly axis-average trend (R-4). Renders raw axis values as-recorded (D-3: DB/UI
// polarity here matches the requirement's own vocabulary -- stress/commCost are "higher is worse"; unlike
// RadarChart.tsx, this is deliberately NOT transformed to a "larger = better" polarity, since a trend line
// is read by its *slope*, not its enclosed area, so there is no "bigger area looks better" illusion to
// correct for here -- the legend states each axis's polarity explicitly instead).
//
// M9 FIX (iter1 major): shared/evaluationAggregate.ts's bucketEvaluationsWeekly/Monthly only ever return
// buckets that actually contain data (no empty-bucket padding) -- plotting those at equal-width index-based
// x positions silently erased any real time gap between two non-adjacent buckets (e.g. a 5-week silent
// stretch would render identically to two back-to-back weeks), misrepresenting the slope this view exists
// to convey. Each bucket already carries its own `startMs` (real elapsed time), so x position is now
// proportional to that instead of to array index -- a wide gap in time now visibly stretches the line
// between the two points on either side of it, rather than implying a steady point-to-point trend across it.
export interface EvaluationLineSeries {
  key: string
  label: string
  color: string
  values: readonly number[]
}

/** One x-axis position: a bucket's display label plus its period-start time (epoch ms, `EvaluationBucket.
 * startMs` from shared/evaluationAggregate.ts) -- the latter drives x placement, the former only the tick
 * text. `series[*].values[i]` must correspond to `points[i]`. */
export interface EvaluationLineChartPoint {
  key: string
  label: string
  timeMs: number
}

interface EvaluationLineChartProps {
  points: readonly EvaluationLineChartPoint[]
  series: readonly EvaluationLineSeries[]
  width?: number
  height?: number
}

const PADDING = { top: 12, right: 16, bottom: 26, left: 32 }

export function EvaluationLineChart({
  points,
  series,
  width = 560,
  height = 200
}: EvaluationLineChartProps): React.JSX.Element {
  const innerWidth = width - PADDING.left - PADDING.right
  const innerHeight = height - PADDING.top - PADDING.bottom
  const n = points.length
  const minTimeMs = n > 0 ? points[0].timeMs : 0
  const maxTimeMs = n > 0 ? points[n - 1].timeMs : 0
  const timeSpanMs = maxTimeMs - minTimeMs

  function xFor(index: number): number {
    if (n <= 1) return PADDING.left + innerWidth / 2
    // Defensive fallback for out-of-order/identical timestamps (should not happen -- buckets are always
    // sorted ascending by startMs, evaluationAggregate.ts): fall back to even spacing rather than divide
    // by zero / collapse every point onto the same x.
    if (timeSpanMs <= 0) return PADDING.left + (innerWidth * index) / (n - 1)
    return PADDING.left + (innerWidth * (points[index].timeMs - minTimeMs)) / timeSpanMs
  }
  function yFor(value: number): number {
    const clamped = Math.max(0, Math.min(100, value))
    return PADDING.top + innerHeight * (1 - clamped / 100)
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="評価スコアの週次/月次遷移"
      className="evaluation-line-chart"
    >
      {[0, 25, 50, 75, 100].map((level) => (
        <line
          key={level}
          x1={PADDING.left}
          x2={width - PADDING.right}
          y1={yFor(level)}
          y2={yFor(level)}
          className="evaluation-line-chart__gridline"
        />
      ))}
      {n === 0 && (
        <text x={width / 2} y={height / 2} textAnchor="middle" className="evaluation-line-chart__empty">
          データがありません
        </text>
      )}
      {series.map((s) => {
        const d = s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xFor(i)},${yFor(v)}`).join(' ')
        return (
          <path
            key={s.key}
            d={d}
            fill="none"
            stroke={s.color}
            className="evaluation-line-chart__line"
          />
        )
      })}
      {series.map((s) =>
        s.values.map((v, i) => (
          <circle
            key={`${s.key}-${i}`}
            cx={xFor(i)}
            cy={yFor(v)}
            r={2.5}
            fill={s.color}
            className="evaluation-line-chart__point"
          />
        ))
      )}
      {points.map((point, i) => (
        <text
          key={point.key}
          x={xFor(i)}
          y={height - 6}
          textAnchor="middle"
          className="evaluation-line-chart__x-label"
        >
          {point.label}
        </text>
      ))}
    </svg>
  )
}
