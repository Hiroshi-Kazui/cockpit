// Tracks the latest SessionSummary pushed for one pane over cockpit:session:updated (M2 minimal
// verification surface -- token/context bar-graph visualization is M3 scope, not implemented here).
import { useEffect, useState } from 'react'
import type { PaneIndex, SessionSummary } from '@shared/ipc'

/** M14 (R-1): `resetKey` lets the pane discard the row it is currently showing without unmounting the
 * hook -- Pane.tsx increments it when a completed purpose's pane is cleaned up on 停止. Any change to it
 * (or to `paneIndex`) drops the summary in the same commit, exactly like the pane switch below. */
export function useSessionTelemetry(paneIndex: PaneIndex, resetKey = 0): SessionSummary | null {
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [tracked, setTracked] = useState({ paneIndex, resetKey })

  // Switching panes invalidates the previous pane's summary. Adjusting during render (rather than in
  // an effect) drops it in the same commit as the pane change, so no frame ever shows pane A's
  // telemetry under pane B's label.
  if (tracked.paneIndex !== paneIndex || tracked.resetKey !== resetKey) {
    setTracked({ paneIndex, resetKey })
    setSummary(null)
  }

  useEffect(() => {
    const unsubscribe = window.cockpit.session.onUpdated((next) => {
      if (next.pane === paneIndex) setSummary(next)
    })
    return unsubscribe
  }, [paneIndex])

  return summary
}
