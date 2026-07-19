// Tracks the latest app-wide 5時間/週次 usage display pushed over cockpit:usage:displayUpdated (spec
// §4.5). Single subscription shared by the status bar; independent of any one pane.
import { useEffect, useState } from 'react'
import type { UsageDisplay } from '@shared/ipc'

export function useRateLimitsDisplay(): UsageDisplay | null {
  const [display, setDisplay] = useState<UsageDisplay | null>(null)

  useEffect(() => {
    return window.cockpit.usage.onDisplayUpdated(setDisplay)
  }, [])

  return display
}
