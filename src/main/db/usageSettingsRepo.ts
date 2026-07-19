// CRUD for the plan-limit settings used by the M3 "推定" fallback (spec §4.5, §5: app_settings keys
// plan_limit_5h / plan_limit_weekly / a preset selector). Reuses the existing key/value app_settings
// table (same one appSettingsRepo.ts uses for claude_path) rather than a new table -- this is exactly
// the kind of setting spec §5 anticipates living there.
import type { Database } from 'better-sqlite3'
import type { PlanPreset, SetUsageSettingsRequest, UsageSettings } from '../../shared/ipc'

export const USAGE_SETTING_KEYS = {
  preset: 'plan_preset',
  customFiveHour: 'plan_limit_5h',
  customWeekly: 'plan_limit_weekly'
} as const

const VALID_PRESETS: readonly PlanPreset[] = ['pro', 'max5x', 'max20x', 'custom']

function isPlanPreset(value: string): value is PlanPreset {
  return (VALID_PRESETS as readonly string[]).includes(value)
}

interface StoredValueRow {
  value: string
}

function getRaw(db: Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    StoredValueRow | undefined
  return row?.value ?? null
}

function setRaw(db: Database, key: string, value: string | null): void {
  if (value === null) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
    return
  }
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (@key, @value)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run({ key, value })
}

// M3 FIX iteration 2 (minor #7): a stored custom limit must be a positive number -- 0/negative
// previously round-tripped as a "valid" limit and would have made estimateUsedPercentage's non-positive
// -limit guard silently zero out the estimate, hiding a corrupted/edited-by-hand setting rather than
// treating it as absent (falling back to the preset default, same as a missing value).
function parseStoredNumber(raw: string | null): number | null {
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Defaults to the 'pro' preset with no custom overrides when nothing has been configured yet. */
export function getUsageSettings(db: Database): UsageSettings {
  const rawPreset = getRaw(db, USAGE_SETTING_KEYS.preset)
  return {
    preset: rawPreset && isPlanPreset(rawPreset) ? rawPreset : 'pro',
    customFiveHourTokens: parseStoredNumber(getRaw(db, USAGE_SETTING_KEYS.customFiveHour)),
    customWeeklyTokens: parseStoredNumber(getRaw(db, USAGE_SETTING_KEYS.customWeekly))
  }
}

export function setUsageSettings(db: Database, req: SetUsageSettingsRequest): void {
  setRaw(db, USAGE_SETTING_KEYS.preset, req.preset)
  setRaw(
    db,
    USAGE_SETTING_KEYS.customFiveHour,
    req.customFiveHourTokens === null ? null : String(req.customFiveHourTokens)
  )
  setRaw(
    db,
    USAGE_SETTING_KEYS.customWeekly,
    req.customWeeklyTokens === null ? null : String(req.customWeeklyTokens)
  )
}
