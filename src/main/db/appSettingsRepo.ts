// CRUD for the app_settings key/value table (spec §5), used in M1 for claude_path override (TD-5).
import type { Database } from 'better-sqlite3'
import type { AppSettings } from '../../shared/ipc'

export const APP_SETTING_KEYS = {
  claudePath: 'claude_path'
} as const

interface AppSettingRow {
  value: string
}

function getRaw(db: Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    AppSettingRow | undefined
  return row?.value ?? null
}

function setRaw(db: Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (@key, @value)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run({ key, value })
}

export function getAppSettings(db: Database): AppSettings {
  return { claudePath: getRaw(db, APP_SETTING_KEYS.claudePath) }
}

export function setClaudePath(db: Database, claudePath: string): void {
  setRaw(db, APP_SETTING_KEYS.claudePath, claudePath)
}
