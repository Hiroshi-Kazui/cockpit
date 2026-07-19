// CRUD for the `purposes` table (spec §5). M2 established create/read (link new sessions to a pane's
// active purpose, TD-2); M4 adds the rest of the lifecycle this table exists for (TD-7): async title
// backfill after headless generation, completion, and bulk restart-recovery lookup.
import crypto from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { PANE_INDICES, toPaneIndex, type PaneIndex, type PurposeSummary } from '../../shared/ipc'
import type { PurposeStore } from '../telemetry/ports'

interface RawPurposeRow {
  id: string
  pane: number
  text: string
  title: string | null
  status: string
  created_at: number
  completed_at: number | null
}

function toSummary(row: RawPurposeRow): PurposeSummary {
  return {
    id: row.id,
    pane: toPaneIndex(row.pane),
    text: row.text,
    title: row.title,
    status: row.status === 'completed' ? 'completed' : 'active',
    createdAt: row.created_at,
    completedAt: row.completed_at
  }
}

export function createPurpose(db: Database, pane: PaneIndex, text: string): PurposeSummary {
  const id = crypto.randomUUID()
  const createdAt = Date.now()
  db.prepare(
    `INSERT INTO purposes (id, pane, text, title, status, created_at, completed_at)
     VALUES (@id, @pane, @text, NULL, 'active', @createdAt, NULL)`
  ).run({ id, pane, text, createdAt })
  const row = db.prepare('SELECT * FROM purposes WHERE id = ?').get(id) as RawPurposeRow
  return toSummary(row)
}

export function getActivePurposeForPane(db: Database, pane: PaneIndex): PurposeSummary | null {
  const row = db
    .prepare(
      `SELECT * FROM purposes WHERE pane = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`
    )
    .get(pane) as RawPurposeRow | undefined
  return row ? toSummary(row) : null
}

/** Backfills the async headless-generated title (or the truncate-fallback on generation failure,
 * spec §4.2 step 5) onto an already-created purpose row. Returns the updated row (null if the id no
 * longer exists) so the caller (purposeCoordinator) can push it to the renderer. */
export function updatePurposeTitle(db: Database, id: string, title: string): PurposeSummary | null {
  db.prepare(`UPDATE purposes SET title = ? WHERE id = ?`).run(title, id)
  const row = db.prepare('SELECT * FROM purposes WHERE id = ?').get(id) as RawPurposeRow | undefined
  return row ? toSummary(row) : null
}

/** M4 (spec §4.2 "目的が空で開始した場合"): sets the purpose's text once decided from the session's
 * first non-command chat turn (see main/telemetry/purposeDetectionCoordinator.ts). Returns the updated
 * row (null if the id no longer exists) so the caller (purposeCoordinator) can push it to the renderer. */
export function updatePurposeText(db: Database, id: string, text: string): PurposeSummary | null {
  db.prepare(`UPDATE purposes SET text = ? WHERE id = ?`).run(text, id)
  const row = db.prepare('SELECT * FROM purposes WHERE id = ?').get(id) as RawPurposeRow | undefined
  return row ? toSummary(row) : null
}

/** M4 (spec §4.2): looks up a single purpose row by id. Used by the purpose-detection wiring
 * (main/index.ts) to confirm a purpose is still `active` (and thus still worth deciding a text for)
 * before acting on a JSONL-derived candidate -- see purposeDetectionCoordinator.ts. */
export function getPurposeById(db: Database, id: string): PurposeSummary | null {
  const row = db.prepare('SELECT * FROM purposes WHERE id = ?').get(id) as RawPurposeRow | undefined
  return row ? toSummary(row) : null
}

/** Pane header "完了" button (spec §4.6, TD-7): marks the purpose completed and records completed_at.
 * Returns the updated row (null if the id no longer exists) so the caller can push it to the renderer. */
export function completePurpose(db: Database, id: string): PurposeSummary | null {
  db.prepare(`UPDATE purposes SET status = 'completed', completed_at = ? WHERE id = ?`).run(
    Date.now(),
    id
  )
  const row = db.prepare('SELECT * FROM purposes WHERE id = ?').get(id) as RawPurposeRow | undefined
  return row ? toSummary(row) : null
}

/** Restart-recovery lookup (spec §4.6, TD-7): every pane's active purpose (if any), for restoring the
 * "目的タイトル＋再開ボタン" pane state on app startup. Reuses getActivePurposeForPane's per-pane
 * "latest active" query (rather than a single `WHERE status = 'active'` scan) so this can never return
 * more than one row per pane even if that invariant were ever violated. */
export function getAllActivePurposes(db: Database): PurposeSummary[] {
  const result: PurposeSummary[] = []
  for (const pane of PANE_INDICES) {
    const purpose = getActivePurposeForPane(db, pane)
    if (purpose) result.push(purpose)
  }
  return result
}

/** Adapts the raw SQLite functions above to the PurposeStore port sessionCoordinator depends on. */
export function createSqlitePurposeStore(db: Database): PurposeStore {
  return {
    getActivePurposeForPane: (pane) => getActivePurposeForPane(db, pane)
  }
}
