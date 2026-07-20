'use strict'
/* eslint-disable no-undef, @typescript-eslint/no-require-imports --
   Standalone Node CJS script invoked via ELECTRON_RUN_AS_NODE (see electronApp.ts's runElectronAsNode doc
   comment for why), not bundled/typed by the project's TS build graph -- same rationale as
   e2e/probes/td1-statusline-probe.js and e2e/fixtures/fake-claude.js. */
// E2E fixture (M8, migration-archive-mirror.spec.ts): seeds `<userDataDir>/cockpit.db` with the pre-M7
// (M6-shape) `archive_mirror` table -- `session_id` alone as its PRIMARY KEY, spec §5 as shipped in M6,
// before the real app's own startup migration (schema.ts's migrateArchiveMirrorToCompositeKey, ADR-0009
// decision 2) ever gets a chance to touch it -- so migration-archive-mirror.spec.ts can then launch the
// real app against this exact file and verify that migration runs successfully and losslessly against the
// *real* better-sqlite3 engine (schema.test.ts's own coverage of this same migration logic runs against a
// hand-built FakeDatabase instead -- see that file's header comment and its "known limitation" note on
// simulated transactions -- specifically because real better-sqlite3 cannot load under plain Node/vitest;
// this script is what lets M8 close that gap in the E2E layer instead).
//
// Must run via ELECTRON_RUN_AS_NODE=1 (see electronApp.ts's runElectronAsNode) -- never plain `node` --
// better-sqlite3's native binary in this repo is rebuilt for Electron's ABI, the same ABI the real app's
// main process itself loads it with; seeding through that exact binary rules out any ABI mismatch with the
// migration that runs moments later when the real app launches against this same file.
const path = require('node:path')
const Database = require('better-sqlite3')

const userDataDir = process.argv[2]
if (!userDataDir) {
  console.error('usage: seed-legacy-archive-mirror.js <userDataDir>')
  process.exit(1)
}

const dbPath = path.join(userDataDir, 'cockpit.db')
const db = new Database(dbPath)
try {
  // Deliberately the exact M6-shipped shape (mirrors schema.test.ts's M6_SHAPE_DDL) -- session_id alone as
  // PRIMARY KEY, no composite key yet.
  db.exec(`
    CREATE TABLE archive_mirror (
      session_id TEXT PRIMARY KEY,
      dest_root TEXT NOT NULL,
      synced_bytes INTEGER NOT NULL DEFAULT 0,
      meta_synced INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      updated_at INTEGER NOT NULL
    );
  `)
  const insert = db.prepare(
    `INSERT INTO archive_mirror
       (session_id, dest_root, synced_bytes, meta_synced, state, last_error, updated_at)
     VALUES (@sessionId, @destRoot, @syncedBytes, @metaSynced, @state, @lastError, @updatedAt)`
  )
  insert.run({
    sessionId: 'legacy-sess-1',
    destRoot: 'legacy-dest-root-a',
    syncedBytes: 42,
    metaSynced: 1,
    state: 'synced',
    lastError: null,
    updatedAt: 1111
  })
  insert.run({
    sessionId: 'legacy-sess-2',
    destRoot: 'legacy-dest-root-b',
    syncedBytes: 7,
    metaSynced: 0,
    state: 'error',
    lastError: 'pre-M7 legacy error',
    updatedAt: 2222
  })
  console.log('seeded')
} finally {
  db.close()
}
