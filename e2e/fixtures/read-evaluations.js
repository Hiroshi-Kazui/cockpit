'use strict'
/* eslint-disable no-undef, @typescript-eslint/no-require-imports -- see seed-purpose-with-evaluation.js */
// E2E fixture (M14): prints every `evaluations` row for one purpose as JSON (newest first), so
// stop-cleanup-and-appeal.spec.ts can assert append-only behavior and the persisted appeal text against
// the real database the app just wrote.
const path = require('node:path')
const Database = require('better-sqlite3')

const userDataDir = process.argv[2]
const purposeId = process.argv[3]
if (!userDataDir || !purposeId) {
  console.error('usage: read-evaluations.js <userDataDir> <purposeId>')
  process.exit(1)
}

const db = new Database(path.join(userDataDir, 'cockpit.db'), { readonly: true })
try {
  const rows = db
    .prepare(
      'SELECT id, status, smoothness, stress, comm_cost, summary, appeal_text FROM evaluations ' +
        'WHERE purpose_id = ? ORDER BY created_at DESC, rowid DESC'
    )
    .all(purposeId)
  process.stdout.write(JSON.stringify(rows) + '\n')
} finally {
  db.close()
}
