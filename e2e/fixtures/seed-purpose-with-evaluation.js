'use strict'
/* eslint-disable no-undef, @typescript-eslint/no-require-imports --
   Standalone CJS fixture run via ELECTRON_RUN_AS_NODE (electronApp.ts's runElectronAsNode), same
   rationale as seed-legacy-archive-mirror.js. */
// E2E fixture (M14, stop-cleanup-and-appeal.spec.ts): seeds `<userDataDir>/cockpit.db` with
//   - one *active* purpose on pane 0 (so the launched app restores it -- getAllActivePurposes only
//     restores active purposes; the test completes it through the real 完了 button),
//   - one already-'ok' evaluation for that purpose, written into a **pre-M14-shaped** `evaluations`
//     table (no `appeal_text` column) so the app's own startup migration (schema.ts's
//     addEvaluationAppealTextColumn, ADR-0016 D-4) is exercised against the real better-sqlite3 engine,
//   - `evaluation_enabled = '0'`, so completing the purpose in-app does not immediately supersede the
//     seeded evaluation with a fresh (input-less) run. The test turns evaluation back on via the real
//     評価設定 UI before appealing.
const path = require('node:path')
const Database = require('better-sqlite3')

const userDataDir = process.argv[2]
const purposeId = process.argv[3]
if (!userDataDir || !purposeId) {
  console.error('usage: seed-purpose-with-evaluation.js <userDataDir> <purposeId>')
  process.exit(1)
}

const db = new Database(path.join(userDataDir, 'cockpit.db'))
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS purposes (
      id TEXT PRIMARY KEY,
      pane INTEGER NOT NULL,
      text TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    -- Deliberately the M9-shipped shape: no appeal_text column.
    CREATE TABLE evaluations (
      id                TEXT PRIMARY KEY,
      purpose_id        TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      model             TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',
      smoothness        INTEGER,
      stress            INTEGER,
      comm_cost         INTEGER,
      summary           TEXT,
      suggestions_json  TEXT,
      input_stats_json  TEXT,
      last_error        TEXT,
      report_state      TEXT
    );
  `)
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('evaluation_enabled', '0')
  db.prepare(
    `INSERT INTO purposes (id, pane, text, title, status, created_at, completed_at)
     VALUES (?, 0, ?, ?, 'active', ?, NULL)`
  ).run(purposeId, 'M14 異議申し立てテストの目的', 'M14異議テスト', 1000)
  db.prepare(
    `INSERT INTO evaluations
       (id, purpose_id, created_at, model, status, smoothness, stress, comm_cost, summary,
        suggestions_json, input_stats_json, last_error, report_state)
     VALUES (?, ?, ?, 'haiku', 'ok', 40, 80, 70, ?, '[]', NULL, NULL, NULL)`
  ).run('m14-seed-eval', purposeId, 2000, '苦戦していました')
  process.stdout.write('seeded\n')
} finally {
  db.close()
}
