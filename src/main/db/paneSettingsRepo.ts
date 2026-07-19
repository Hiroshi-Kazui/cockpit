// CRUD for the pane_settings table (spec §5) — the only module allowed to persist pane cwd.
import type { Database } from 'better-sqlite3'
import type { PaneIndex, PaneSetting } from '../../shared/ipc'
import { isPaneIndex, PANE_INDICES } from '../../shared/ipc'

interface PaneSettingRow {
  pane: number
  default_cwd: string | null
}

export function getAllPaneSettings(db: Database): PaneSetting[] {
  const rows = db.prepare('SELECT pane, default_cwd FROM pane_settings').all() as PaneSettingRow[]
  const byPane = new Map<number, string | null>(rows.map((r) => [r.pane, r.default_cwd]))
  return PANE_INDICES.map((pane) => ({ pane, defaultCwd: byPane.get(pane) ?? null }))
}

export function setPaneCwd(db: Database, pane: PaneIndex, cwd: string): void {
  if (!isPaneIndex(pane)) {
    throw new Error(`Invalid pane index: ${String(pane)}`)
  }
  db.prepare(
    `INSERT INTO pane_settings (pane, default_cwd) VALUES (@pane, @cwd)
     ON CONFLICT(pane) DO UPDATE SET default_cwd = excluded.default_cwd`
  ).run({ pane, cwd })
}
