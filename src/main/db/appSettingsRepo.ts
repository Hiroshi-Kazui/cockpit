// CRUD for the app_settings key/value table (spec §5), used in M1 for claude_path override (TD-5) and
// M6 for the archive-output mirror destination (spec §4.4.1, ADR-0008/D-6).
import type { Database } from 'better-sqlite3'
import type { AppSettings } from '../../shared/ipc'
import { isLayoutMode, type LayoutMode } from '../../shared/layout'

export const APP_SETTING_KEYS = {
  claudePath: 'claude_path',
  archiveOutputRoot: 'archive_output_root',
  layoutMode: 'layout_mode',
  evaluationEnabled: 'evaluation_enabled',
  evaluationModel: 'evaluation_model',
  evaluationOutputRoot: 'evaluation_output_root'
} as const

/** M9 (ADR-0010 D-2): default model for the headless evaluation one-shot -- same economy-first choice as
 * titleGenerator's own hardcoded 'haiku' (shared/title.ts's buildTitlePrompt call site), but configurable
 * here via app_settings.evaluation_model. */
export const DEFAULT_EVALUATION_MODEL = 'haiku'

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

/** Defaults to true (ON) when never set / stored value is unrecognized -- ADR-0010 D-2's "既定 ON". */
function getEvaluationEnabled(db: Database): boolean {
  const raw = getRaw(db, APP_SETTING_KEYS.evaluationEnabled)
  return raw !== '0'
}

function getEvaluationModel(db: Database): string {
  const raw = getRaw(db, APP_SETTING_KEYS.evaluationModel)
  return raw && raw.trim().length > 0 ? raw : DEFAULT_EVALUATION_MODEL
}

export function getAppSettings(db: Database): AppSettings {
  return {
    claudePath: getRaw(db, APP_SETTING_KEYS.claudePath),
    archiveOutputRoot: getRaw(db, APP_SETTING_KEYS.archiveOutputRoot),
    layoutMode: getLayoutMode(db),
    evaluationEnabled: getEvaluationEnabled(db),
    evaluationModel: getEvaluationModel(db),
    evaluationOutputRoot: getRaw(db, APP_SETTING_KEYS.evaluationOutputRoot)
  }
}

export function setEvaluationEnabled(db: Database, enabled: boolean): void {
  setRaw(db, APP_SETTING_KEYS.evaluationEnabled, enabled ? '1' : '0')
}

export function setEvaluationModel(db: Database, model: string): void {
  setRaw(db, APP_SETTING_KEYS.evaluationModel, model)
}

/** M9 (ADR-0010 D-5): `null` clears the setting (report write-through stops) without deleting any report
 * already written -- same "clear the setting, not the data" convention as setArchiveOutputRoot below. */
export function setEvaluationOutputRoot(db: Database, root: string | null): void {
  if (root === null) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(APP_SETTING_KEYS.evaluationOutputRoot)
    return
  }
  setRaw(db, APP_SETTING_KEYS.evaluationOutputRoot, root)
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
