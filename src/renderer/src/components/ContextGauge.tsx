// Context-consumption gauge shown in a pane header (spec §4.5): how close the current conversation is
// to needing a /compact, colored green/orange/red per shared/usage.ts's contextGaugeColor thresholds.
// Purely presentational -- the percentage/color are computed in main (usageCoordinator.ts) from the
// shared/usage.ts pure functions; this component only renders the already-computed result.
//
// M3 FIX iteration 2 (major #1): a prior real user misread this gauge as *cumulative token count*
// because the only always-visible label was the bare word "context" (the "until compact" meaning and the
// remaining-% were both hidden behind the hover `title`). To prevent that recurring, both the
// "compact までの目安" framing and a "残り N%" readout are now always visible (never hover-only), and are
// kept visually distinct from the separate cumulative-token line rendered elsewhere (.pane-telemetry).
import type { ContextGaugeColor } from '@shared/ipc'
import { clampPercentage } from '@shared/usage'

interface ContextGaugeProps {
  usedPercentage: number
  color: ContextGaugeColor
}

export function ContextGauge({ usedPercentage, color }: ContextGaugeProps): React.JSX.Element {
  const pct = Math.round(clampPercentage(usedPercentage))
  const remaining = 100 - pct
  return (
    <div
      className="context-gauge"
      title={`コンテキスト使用率 ${pct}%（compact まで残り約 ${remaining}%）`}
    >
      <div className="context-gauge__label">
        <span>context（compactまで）</span>
        <span className={`context-gauge__pct context-gauge__pct--${color}`}>{pct}%</span>
      </div>
      <div className="context-gauge__bar">
        <div
          className={`context-gauge__fill context-gauge__fill--${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="context-gauge__remaining">残り {remaining}%</div>
    </div>
  )
}
