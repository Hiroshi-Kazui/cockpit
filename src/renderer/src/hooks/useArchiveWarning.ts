// Tracks the latest archive-sync error message for one pane, pushed over
// cockpit:session:archiveError (M2 FIX major #4: transcript archiving failures must be visible, not
// silently swallowed to console -- record-completeness is this app's core purpose, spec §1/§4.4).
import { useEffect, useState } from 'react'
import type { PaneIndex } from '@shared/ipc'

/** M14 (R-1): `resetKey` -- see useSessionTelemetry's identical parameter. Incremented by Pane.tsx when a
 * completed purpose's pane is cleaned up on 停止, so the warning row does not outlive the session it was
 * raised for. */
export function useArchiveWarning(paneIndex: PaneIndex, resetKey = 0): string | null {
  const [message, setMessage] = useState<string | null>(null)
  const [tracked, setTracked] = useState({ paneIndex, resetKey })

  // A warning belongs to the pane it was raised for; switching panes clears it in the same commit as
  // the pane change, so pane A's archive error is never shown against pane B.
  if (tracked.paneIndex !== paneIndex || tracked.resetKey !== resetKey) {
    setTracked({ paneIndex, resetKey })
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
