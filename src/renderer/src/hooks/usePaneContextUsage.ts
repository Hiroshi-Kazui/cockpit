// Tracks the latest context-window usage gauge reading for one pane, pushed over
// cockpit:usage:paneContextUpdated whenever a new statusLine event carries a context percentage (spec
// §4.5: "やり取りのたびに即時更新"). Resets to null when the pane's claude process starts or exits, so a
// stale reading from a previous session never lingers into the next one.
import { useEffect, useState } from 'react'
import type { ContextGaugeColor, PaneIndex } from '@shared/ipc'

export interface PaneContextUsage {
  usedPercentage: number
  color: ContextGaugeColor
}

export function usePaneContextUsage(
  paneIndex: PaneIndex,
  running: boolean
): PaneContextUsage | null {
  const [usage, setUsage] = useState<PaneContextUsage | null>(null)

  // A fresh pty lifecycle (start or exit) invalidates any prior reading -- it belonged to the previous
  // session, not whatever comes next in this pane.
  useEffect(() => {
    setUsage(null)
  }, [paneIndex, running])

  useEffect(() => {
    const unsubscribe = window.cockpit.usage.onPaneContextUpdated((event) => {
      if (event.pane === paneIndex)
        setUsage({ usedPercentage: event.usedPercentage, color: event.color })
    })
    return unsubscribe
  }, [paneIndex])

  return usage
}
