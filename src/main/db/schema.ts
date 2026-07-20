// Idempotent DDL for the cockpit SQLite schema (spec §5, TD-6). Deliberately free of any Electron
// import (`app.getPath` etc. live in db.ts) so it can be exercised directly against an in-memory
// better-sqlite3 database in unit tests without requiring the Electron runtime.
import type { Database } from 'better-sqlite3'

interface TableInfoColumn {
  name: string
  pk: number
}

/**
 * Pure decision (ADR-0009): does the on-disk `archive_mirror` table (if any) still have the M6 shape --
 * `session_id` alone as its PRIMARY KEY -- and therefore need migrating to the composite
 * `(session_id, dest_root)` key this milestone requires for per-root mirror progress? Takes
 * `PRAGMA table_info(archive_mirror)`'s rows directly (already reduced to just `name`/`pk`, the two
 * fields this decision needs) so it is exercised without any real database at all (schema.test.ts) --
 * real better-sqlite3 cannot load under plain Node/vitest here (sessionRepo.test.ts's header comment).
 * An empty array means the table does not exist yet (fresh install): nothing to migrate, the
 * `CREATE TABLE IF NOT EXISTS` below creates it already in the new shape directly.
 */
export function needsArchiveMirrorMigration(columns: readonly TableInfoColumn[]): boolean {
  if (columns.length === 0) return false
  const pkColumns = columns.filter((c) => c.pk > 0).map((c) => c.name)
  return pkColumns.length === 1 && pkColumns[0] === 'session_id'
}

/**
 * ADR-0009 decision 2, idempotent startup migration: a pre-M7 `archive_mirror` table (session_id alone as
 * PRIMARY KEY, spec §5 as shipped in M6) is rebuilt with the composite `(session_id, dest_root)` key each
 * output root's independent mirror progress needs. Every existing row already has a `dest_root` column
 * (just not part of its key), so `INSERT ... SELECT` carries every row's full history across verbatim --
 * no information is lost. Runs *before* the `CREATE TABLE IF NOT EXISTS archive_mirror` further down in
 * `migrate()`, so a not-yet-migrated table is actually rebuilt rather than left untouched by that
 * IF-NOT-EXISTS no-op guard. A fresh install (table does not exist) or an already-migrated table (composite
 * key already in place) both make `needsArchiveMirrorMigration` return false, making this a safe no-op on
 * every subsequent startup (TD-6's idempotent-migration precedent).
 *
 * FIX (blocking, code review): the CREATE/INSERT/DROP/RENAME sequence is wrapped in a single SQLite
 * transaction (`database.transaction`, not four separately-autocommitted statements) -- SQLite's DDL is
 * fully transactional, so a crash (power loss, OS/process kill) anywhere in the middle rolls the whole
 * sequence back atomically instead of leaving a half-migrated, unrecoverable state (a bare `db.exec` with
 * no transaction would otherwise commit each statement independently: a crash between the CREATE and the
 * DROP would leave `archive_mirror__m7_migrating` behind *and* the old-shape `archive_mirror` untouched,
 * so the next startup's retry would still see `needsArchiveMirrorMigration` return true and re-attempt
 * `CREATE TABLE archive_mirror__m7_migrating` -- "table already exists" -- throwing out of `migrate()` and
 * permanently failing every subsequent app launch). `DROP TABLE IF EXISTS` on the scratch table *before*
 * creating it is additional defense-in-depth for the same scenario -- even if a transaction somehow still
 * left a stray scratch table around (e.g. an already-migrated DB manually edited), re-running this is safe.
 */
function migrateArchiveMirrorToCompositeKey(database: Database): void {
  const columns = database.prepare('PRAGMA table_info(archive_mirror)').all() as TableInfoColumn[]
  if (!needsArchiveMirrorMigration(columns)) return

  const runMigration = database.transaction(() => {
    database.exec(`
      DROP TABLE IF EXISTS archive_mirror__m7_migrating;
      CREATE TABLE archive_mirror__m7_migrating (
        session_id   TEXT NOT NULL,
        dest_root    TEXT NOT NULL,
        synced_bytes INTEGER NOT NULL DEFAULT 0,
        meta_synced  INTEGER NOT NULL DEFAULT 0,
        state        TEXT NOT NULL DEFAULT 'pending',
        last_error   TEXT,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (session_id, dest_root)
      );
      INSERT INTO archive_mirror__m7_migrating
        (session_id, dest_root, synced_bytes, meta_synced, state, last_error, updated_at)
      SELECT session_id, dest_root, synced_bytes, meta_synced, state, last_error, updated_at
      FROM archive_mirror;
      DROP TABLE archive_mirror;
      ALTER TABLE archive_mirror__m7_migrating RENAME TO archive_mirror;
    `)
  })
  runMigration()
}

export function migrate(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS pane_settings (
      pane INTEGER PRIMARY KEY,
      default_cwd TEXT
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS purposes (
      id TEXT PRIMARY KEY,
      pane INTEGER NOT NULL,
      text TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      pane INTEGER NOT NULL,
      purpose_id TEXT,
      origin TEXT NOT NULL DEFAULT 'dialog',
      purpose TEXT,
      title TEXT,
      cwd TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      jsonl_path TEXT,
      model TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_pane ON sessions(pane);
    CREATE INDEX IF NOT EXISTS idx_purposes_pane_status ON purposes(pane, status);
    -- M5 (spec §4.4): the past-session browser always orders by started_at DESC (main/db/sessionRepo.ts's
    -- listSessions).
    CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC);
  `)

  // M7 (ADR-0009): must run before the archive_mirror CREATE TABLE IF NOT EXISTS below -- see this
  // function's own doc comment for why.
  migrateArchiveMirrorToCompositeKey(database)

  database.exec(`
    -- M6/M7 (spec §5, ADR-0008 D-6 superseded by ADR-0009): archive-output mirror sync progress. A
    -- *recoverable derived* view of how far the spool ("userData/archive", the record of truth) has been
    -- mirrored into a given dest_root -- never itself a source of truth, and never the SQLite DB's own
    -- location (D-1: cockpit.db always stays in userData, is never mirrored). Keyed by
    -- (session_id, dest_root): each output root keeps its own independent progress row, so switching roots
    -- A -> B -> A no longer loses A's progress record the way the M6 single-row-per-session schema did
    -- (ADR-0009 decision 1).
    CREATE TABLE IF NOT EXISTS archive_mirror (
      session_id   TEXT NOT NULL,
      dest_root    TEXT NOT NULL,
      synced_bytes INTEGER NOT NULL DEFAULT 0,
      meta_synced  INTEGER NOT NULL DEFAULT 0,
      state        TEXT NOT NULL DEFAULT 'pending',
      last_error   TEXT,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (session_id, dest_root)
    );

    CREATE INDEX IF NOT EXISTS idx_archive_mirror_dest_root ON archive_mirror(dest_root);
  `)
}
