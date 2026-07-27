// Tracks the latest SessionSummary pushed for one pane over cockpit:session:updated (M2 minimal
// verification surface -- token/context bar-graph visualization is M3 scope, not implemented here).
import { useEffect, useState } from 'react'
import type { PaneIndex, SessionSummary } from '@shared/ipc'

export function useSessionTelemetry(paneIndex: PaneIndex): SessionSummary | null {
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [trackedPane, setTrackedPane] = useState(paneIndex)

  // Switching panes invalidates the previous pane's summary. Adjusting during render (rather than in
  // an effect) drops it in the same commit as the pane change, so no frame ever shows pane A's
  // telemetry under pane B's label.
  if (trackedPane !== paneIndex) {
    setTrackedPane(paneIndex)
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
