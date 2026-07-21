// CRUD for the app_settings key/value table (spec §5), used in M1 for claude_path override (TD-5) and
// M6 for the archive-output mirror destination (spec §4.4.1, ADR-0008/D-6).
import type { Database } from 'better-sqlite3'
import type { AppSettings } from '../../shared/ipc'
import { isLayoutMode, type LayoutMode } from '../../shared/layout'

export const APP_SETTING_KEYS = {
  claudePath: 'claude_path',
  archiveOutputRoot: 'archive_output_root',
  layoutMode: 'layout_mode'
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

/** Defaults to 'single' when unset or the stored value is unrecognized (e.g. hand-edited DB / schema
 * drift) -- same tolerant-parse philosophy as usageSettingsRepo: never surface a corrupt value as a
 * "valid" layout, fall back to the safe default instead. */
function getLayoutMode(db: Database): LayoutMode {
  const raw = getRaw(db, APP_SETTING_KEYS.layoutMode)
  return raw !== null && isLayoutMode(raw) ? raw : 'single'
}

export function getAppSettings(db: Database): AppSettings {
  return {
    claudePath: getRaw(db, APP_SETTING_KEYS.claudePath),
    archiveOutputRoot: getRaw(db, APP_SETTING_KEYS.archiveOutputRoot),
    layoutMode: getLayoutMode(db)
  }
}

/** Persists the pane split layout so the next launch reopens with it (spec §4.1). */
export function setLayoutMode(db: Database, mode: LayoutMode): void {
  setRaw(db, APP_SETTING_KEYS.layoutMode, mode)
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
