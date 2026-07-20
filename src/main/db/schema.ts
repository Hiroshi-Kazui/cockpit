// Idempotent DDL for the cockpit SQLite schema (spec §5, TD-6). Deliberately free of any Electron
// import (`app.getPath` etc. live in db.ts) so it can be exercised directly against an in-memory
// better-sqlite3 database in unit tests without requiring the Electron runtime.
import type { Database } from 'better-sqlite3'

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

    -- M6 (spec §5, ADR-0008/D-6): archive-output mirror sync progress. A *recoverable derived* view of
    -- how far the spool ("userData/archive", the record of truth) has been mirrored into dest_root --
    -- never itself a source of truth, and never the SQLite DB's own location (D-1: cockpit.db always
    -- stays in userData, is never mirrored).
    CREATE TABLE IF NOT EXISTS archive_mirror (
      session_id   TEXT PRIMARY KEY,
      dest_root    TEXT NOT NULL,
      synced_bytes INTEGER NOT NULL DEFAULT 0,
      meta_synced  INTEGER NOT NULL DEFAULT 0,
      state        TEXT NOT NULL DEFAULT 'pending',
      last_error   TEXT,
      updated_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_archive_mirror_dest_root ON archive_mirror(dest_root);
  `)
}
