// Tracks the latest SessionSummary pushed for one pane over cockpit:session:updated (M2 minimal
// verification surface -- token/context bar-graph visualization is M3 scope, not implemented here).
import { useEffect, useState } from 'react'
import type { PaneIndex, SessionSummary } from '@shared/ipc'

export function useSessionTelemetry(paneIndex: PaneIndex): SessionSummary | null {
  const [summary, setSummary] = useState<SessionSummary | null>(null)

  useEffect(() => {
    setSummary(null)
    const unsubscribe = window.cockpit.session.onUpdated((next) => {
      if (next.pane === paneIndex) setSummary(next)
    })
    return unsubscribe
  }, [paneIndex])

  return summary
}
