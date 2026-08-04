// Pure SVG radar (spider) chart, hand-rolled (D-7: no chart-library dependency is added). N-axis capable
// (the M9 evaluation dialog always passes exactly 3 axes today, but nothing here assumes that -- ADR-0010
// D-7/scope note: "拡張はレーダー描画...がN軸対応の純関数である範囲で将来"). Every axis value is expected
// to already be normalized to the 0-100 "larger area = better" polarity (D-3) by the caller -- this
// component itself performs no polarity transform.
export interface RadarAxis {
  key: string
  label: string
  /** 0-100, larger = better (caller is responsible for any polarity transform, D-3). */
  value: number
}

interface RadarChartProps {
  axes: readonly RadarAxis[]
  size?: number
}

function clamp01to100(value: number): number {
  return Math.max(0, Math.min(100, value))
}

export function RadarChart({ axes, size = 220 }: RadarChartProps): React.JSX.Element {
  const center = size / 2
  const radius = size / 2 - 40
  const angleStep = axes.length > 0 ? (2 * Math.PI) / axes.length : 0

  function pointAt(index: number, fraction: number): { x: number; y: number } {
    const angle = -Math.PI / 2 + index * angleStep
    const r = radius * fraction
    return { x: center + r * Math.cos(angle), y: center + r * Math.sin(angle) }
  }

  const gridLevels = [0.25, 0.5, 0.75, 1]
  const areaPoints = axes
    .map((axis, i) => {
      const p = pointAt(i, clamp01to100(axis.value) / 100)
      return `${p.x},${p.y}`
    })
    .join(' ')

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`評価レーダーチャート: ${axes.map((a) => `${a.label} ${Math.round(clamp01to100(a.value))}`).join('、')}`}
      className="radar-chart"
    >
      {gridLevels.map((level) => (
        <polygon
          key={level}
          points={axes.map((_, i) => `${pointAt(i, level).x},${pointAt(i, level).y}`).join(' ')}
          className="radar-chart__grid"
        />
      ))}
      {axes.map((axis, i) => {
        const p = pointAt(i, 1)
        return <line key={axis.key} x1={center} y1={center} x2={p.x} y2={p.y} className="radar-chart__spoke" />
      })}
      {axes.length > 0 && <polygon points={areaPoints} className="radar-chart__area" />}
      {axes.map((axis, i) => {
        const labelPoint = pointAt(i, 1.22)
        return (
          <text
            key={axis.key}
            x={labelPoint.x}
            y={labelPoint.y}
            textAnchor="middle"
            dominantBaseline="middle"
            className="radar-chart__label"
          >
            {axis.label} ({Math.round(clamp01to100(axis.value))})
          </text>
        )
      })}
    </svg>
  )
}
