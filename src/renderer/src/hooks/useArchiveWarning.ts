// Tracks the latest archive-sync error message for one pane, pushed over
// cockpit:session:archiveError (M2 FIX major #4: transcript archiving failures must be visible, not
// silently swallowed to console -- record-completeness is this app's core purpose, spec §1/§4.4).
import { useEffect, useState } from 'react'
import type { PaneIndex } from '@shared/ipc'

export function useArchiveWarning(paneIndex: PaneIndex): string | null {
  const [message, setMessage] = useState<string | null>(null)
  const [trackedPane, setTrackedPane] = useState(paneIndex)

  // A warning belongs to the pane it was raised for; switching panes clears it in the same commit as
  // the pane change, so pane A's archive error is never shown against pane B.
  if (trackedPane !== paneIndex) {
    setTrackedPane(paneIndex)
    setMessage(null)
  }

  useEffect(() => {
    const unsubscribe = window.cockpit.session.onArchiveError((event) => {
      if (event.pane === paneIndex) setMessage(event.message)
    })
    return unsubscribe
  }, [paneIndex])

  return message
}
