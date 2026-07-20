// Tracks the archive-output mirror's current status (M6, spec §4.4.1): loads the initial snapshot, then
// stays live via the push channel main/index.ts fires whenever any session's mirror state changes.
// `null` means "not yet loaded" (distinct from `{ outputRoot: null, entries: [] }`, which means "loaded,
// and mirroring is not configured") -- consumers (StatusBar's error badge, ArchiveOutputSettings) should
// treat `null` as "still loading" rather than "no error".
import { useEffect, useState } from 'react'
import type { MirrorStatusSummary } from '@shared/ipc'

export function useMirrorStatus(): MirrorStatusSummary | null {
  const [status, setStatus] = useState<MirrorStatusSummary | null>(null)

  useEffect(() => {
    let cancelled = false
    window.cockpit.archive
      .getMirrorStatus()
      .then((result) => {
        if (!cancelled) setStatus(result)
      })
      .catch(() => {
        // Load failure here is not itself a mirror-sync error (spec §4.4.1's error surfacing is about
        // per-session mirror state, not this IPC round-trip) -- leave `status` at null; the next push (or
        // a later successful load, e.g. after the dialog reopens) will populate it.
      })
    const unsubscribe = window.cockpit.archive.onMirrorStatusUpdated((summary) => {
      if (!cancelled) setStatus(summary)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return status
}
