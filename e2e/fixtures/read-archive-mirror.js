'use strict'
/* eslint-disable no-undef, @typescript-eslint/no-require-imports --
   Standalone Node CJS script invoked via ELECTRON_RUN_AS_NODE -- see
   seed-legacy-archive-mirror.js's header comment for the identical rationale. */
// E2E fixture (M8, migration-archive-mirror.spec.ts): reads back `<userDataDir>/cockpit.db`'s
// `archive_mirror` table's current column shape (PRAGMA table_info) and row contents as a single line of
// JSON on stdout, once the real app (and its startup migration) has run against it and exited -- so
// migration-archive-mirror.spec.ts can assert the migration actually produced the composite
// (session_id, dest_root) key, losslessly, against the real on-disk file (not a fake).
//
// Opened read-only: this script must never itself be a second writer racing the app's own connection --
// by the time it runs, the app has already been closed (closeApp), so there is no live writer to race
// regardless, but `readonly: true` documents that intent and fails loudly (rather than silently succeeding
// on a wrong assumption) if that invariant is ever violated by a future caller.
const path = require('node:path')
const Database = require('better-sqlite3')

const userDataDir = process.argv[2]
if (!userDataDir) {
  console.error('usage: read-archive-mirror.js <userDataDir>')
  process.exit(1)
}

const dbPath = path.join(userDataDir, 'cockpit.db')
const db = new Database(dbPath, { readonly: true })
try {
  const columns = db.prepare('PRAGMA table_info(archive_mirror)').all()
  const rows = db.prepare('SELECT * FROM archive_mirror ORDER BY session_id').all()
  process.stdout.write(JSON.stringify({ columns, rows }))
} finally {
  db.close()
}
