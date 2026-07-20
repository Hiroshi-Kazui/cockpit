// CRUD for the app_settings key/value table (spec §5), used in M1 for claude_path override (TD-5) and
// M6 for the archive-output mirror destination (spec §4.4.1, ADR-0008/D-6).
import type { Database } from 'better-sqlite3'
import type { AppSettings } from '../../shared/ipc'

export const APP_SETTING_KEYS = {
  claudePath: 'claude_path',
  archiveOutputRoot: 'archive_output_root'
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
  return {
    claudePath: getRaw(db, APP_SETTING_KEYS.claudePath),
    archiveOutputRoot: getRaw(db, APP_SETTING_KEYS.archiveOutputRoot)
  }
}

export function setClaudePath(db: Database, claudePath: string): void {
  setRaw(db, APP_SETTING_KEYS.claudePath, claudePath)
}

/** M6 (spec §4.4.1, ADR-0008/D-4): `null` clears the setting (mirroring stops being configured) without
 * deleting anything already mirrored -- archive_mirror rows and destination files are untouched, they
 * simply stop receiving new syncs (main/archive/mirror/mirrorCoordinator.ts). */
export function setArchiveOutputRoot(db: Database, root: string | null): void {
  if (root === null) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(APP_SETTING_KEYS.archiveOutputRoot)
    return
  }
  setRaw(db, APP_SETTING_KEYS.archiveOutputRoot, root)
}
