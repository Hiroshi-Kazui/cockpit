// Loads and updates the plan-limit settings used by the estimated-fallback display (spec §4.5:
// "設定画面のプラン上限...手動調整可"). Errors are surfaced, not swallowed (CLAUDE.md: no silent
// failure) -- callers render `error` alongside the control.
import { useCallback, useEffect, useState } from 'react'
import type { UsageSettings } from '@shared/ipc'

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface UseUsageSettingsResult {
  settings: UsageSettings | null
  error: string | null
  update: (next: UsageSettings) => Promise<void>
}

export function useUsageSettings(): UseUsageSettingsResult {
  const [settings, setSettings] = useState<UsageSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.cockpit.usage
      .getSettings()
      .then(setSettings)
      .catch((err: unknown) => setError(describeError(err)))
  }, [])

  const update = useCallback(async (next: UsageSettings): Promise<void> => {
    setError(null)
    try {
      await window.cockpit.usage.setSettings(next)
      setSettings(next)
    } catch (err) {
      setError(describeError(err))
    }
  }, [])

  return { settings, error, update }
}
