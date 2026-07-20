// CRUD for the archive_mirror table, keyed by (session_id, dest_root) since ADR-0009 (M7 -- supersedes
// M6/ADR-0008's session_id-only key; see schema.ts's migrate() for the idempotent startup migration of
// pre-M7 databases). Mirrors the same dependency-inversion pattern as sessionRepo.ts's
// createSqliteSessionStore: the raw better-sqlite3 functions below are adapted to the narrow
// `ArchiveMirrorRepoPort` port that main/archive/mirror/mirrorCoordinator.ts depends on, so the
// coordinator's sync/backfill/recovery logic is unit-testable against an in-memory fake (better-sqlite3's
// native binary cannot load under plain Node/vitest here -- rebuilt for Electron's ABI, see
// sessionRepo.ts's header comment for the same constraint already documented there).
import type { Database } from 'better-sqlite3'
import type { MirrorState } from '../../shared/ipc'

export interface ArchiveMirrorRow {
  sessionId: string
  destRoot: string
  syncedBytes: number
  metaSynced: boolean
  state: MirrorState
  lastError: string | null
  updatedAt: number
}

export interface ArchiveMirrorRepoPort {
  /** Looks up the row for this exact (session, dest_root) pair -- ADR-0009: each output root a session has
   * ever been mirrored to keeps its own independent progress row, so this never returns a stale row
   * belonging to a *different* root the session happens to also be tracked against. */
  get(sessionId: string, destRoot: string): ArchiveMirrorRow | null
  upsert(row: ArchiveMirrorRow): void
  listAll(): ArchiveMirrorRow[]
  listForDestRoot(destRoot: string): ArchiveMirrorRow[]
}

interface RawArchiveMirrorRow {
  session_id: string
  dest_root: string
  synced_bytes: number
  meta_synced: number
  state: string
  last_error: string | null
  updated_at: number
}

function isMirrorState(value: string): value is MirrorState {
  return value === 'pending' || value === 'synced' || value === 'error'
}

function toRow(raw: RawArchiveMirrorRow): ArchiveMirrorRow {
  return {
    sessionId: raw.session_id,
    destRoot: raw.dest_root,
    syncedBytes: raw.synced_bytes,
    metaSynced: raw.meta_synced === 1,
    // Defensive fallback (schema drift / hand-edited row) rather than crashing -- mirrors sessionRepo.ts's
    // isSessionOrigin fallback-to-known-default pattern.
    state: isMirrorState(raw.state) ? raw.state : 'pending',
    lastError: raw.last_error,
    updatedAt: raw.updated_at
  }
}

export function getArchiveMirrorRow(
  db: Database,
  sessionId: string,
  destRoot: string
): ArchiveMirrorRow | null {
  const row = db
    .prepare('SELECT * FROM archive_mirror WHERE session_id = ? AND dest_root = ?')
    .get(sessionId, destRoot) as RawArchiveMirrorRow | undefined
  return row ? toRow(row) : null
}

export function upsertArchiveMirrorRow(db: Database, row: ArchiveMirrorRow): void {
  db.prepare(
    `INSERT INTO archive_mirror
       (session_id, dest_root, synced_bytes, meta_synced, state, last_error, updated_at)
     VALUES
       (@sessionId, @destRoot, @syncedBytes, @metaSynced, @state, @lastError, @updatedAt)
     ON CONFLICT(session_id, dest_root) DO UPDATE SET
       synced_bytes = excluded.synced_bytes,
       meta_synced = excluded.meta_synced,
       state = excluded.state,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`
  ).run({
    sessionId: row.sessionId,
    destRoot: row.destRoot,
    syncedBytes: row.syncedBytes,
    metaSynced: row.metaSynced ? 1 : 0,
    state: row.state,
    lastError: row.lastError,
    updatedAt: row.updatedAt
  })
}

export function listAllArchiveMirrorRows(db: Database): ArchiveMirrorRow[] {
  const rows = db.prepare('SELECT * FROM archive_mirror').all() as RawArchiveMirrorRow[]
  return rows.map(toRow)
}

export function listArchiveMirrorRowsForDestRoot(
  db: Database,
  destRoot: string
): ArchiveMirrorRow[] {
  const rows = db
    .prepare('SELECT * FROM archive_mirror WHERE dest_root = ?')
    .all(destRoot) as RawArchiveMirrorRow[]
  return rows.map(toRow)
}

/** Real adapter, backed by SQLite -- see this file's header comment for why mirrorCoordinator depends on
 * the narrow `ArchiveMirrorRepoPort` instead of a raw `Database` handle. */
export function createSqliteArchiveMirrorRepo(db: Database): ArchiveMirrorRepoPort {
  return {
    get: (sessionId, destRoot) => getArchiveMirrorRow(db, sessionId, destRoot),
    upsert: (row) => upsertArchiveMirrorRow(db, row),
    listAll: () => listAllArchiveMirrorRows(db),
    listForDestRoot: (destRoot) => listArchiveMirrorRowsForDestRoot(db, destRoot)
  }
}
