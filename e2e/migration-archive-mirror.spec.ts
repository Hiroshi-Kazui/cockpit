// M8 E2E suite (Playwright + Electron): startup migration of a legacy (M6-shape, single `session_id`
// PRIMARY KEY) `archive_mirror` table to the composite `(session_id, dest_root)` key ADR-0009/M7 requires.
//
// schema.test.ts already exercises schema.ts's actual migrate() SQL text (unit-level) against a hand-built
// in-memory FakeDatabase -- deliberately, because real better-sqlite3 cannot load under plain Node/vitest
// here (its native binary is rebuilt for Electron's ABI). That fake does not attempt to simulate real
// SQLite/better-sqlite3 transaction semantics (see its header comment), which is the exact gap this spec
// closes: it seeds a real on-disk cockpit.db with the legacy shape (via e2e/fixtures/
// seed-legacy-archive-mirror.js, run through the project's own Electron binary in ELECTRON_RUN_AS_NODE mode
// so better-sqlite3 loads with the correct ABI -- see electronApp.ts's runElectronAsNode), launches the
// real, unmodified app against it, and verifies both that the app starts up successfully and that the
// migration actually ran losslessly against the real engine.
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeApp, launchApp, runElectronAsNode, type LaunchedApp } from './fixtures/electronApp'

interface TableInfoColumn {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: unknown
  pk: number
}

interface ArchiveMirrorRow {
  session_id: string
  dest_root: string
  synced_bytes: number
  meta_synced: number
  state: string
  last_error: string | null
  updated_at: number
}

const SEED_SCRIPT = path.join(__dirname, 'fixtures', 'seed-legacy-archive-mirror.js')
const READ_SCRIPT = path.join(__dirname, 'fixtures', 'read-archive-mirror.js')

test.describe('startup migration of a legacy-shape archive_mirror table (M8, ADR-0009 decision 2)', () => {
  test('a real on-disk M6-shape (session_id PK) cockpit.db migrates losslessly to the composite key, and the app starts up successfully', async () => {
    test.setTimeout(60_000)
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-migration-userdata-'))
    let launched: LaunchedApp | undefined

    try {
      runElectronAsNode(SEED_SCRIPT, [userDataDir])
      // Sanity: the seed script must have actually produced a legacy-shape cockpit.db before the app is
      // ever launched against it -- otherwise this test would trivially pass by migrating nothing.
      expect(fs.existsSync(path.join(userDataDir, 'cockpit.db'))).toBe(true)

      // The real, unmodified app -- launchApp already waits for '.app-header h1' to appear, so a successful
      // launch here is itself part of what this test verifies (a migration bug that throws inside
      // migrate() would otherwise fail app startup entirely, per schema.test.ts's own "must not throw"
      // regression-test precedent for the equivalent unit-level scenario).
      launched = await launchApp(userDataDir)
      await expect(launched.window.locator('.app-header h1')).toHaveText('cockpit')

      // Close before reading the file back -- this readback must never race the app's own live connection.
      // Deliberately `launched.app.close()` directly, not the shared closeApp() helper -- closeApp also
      // removes `userDataDir` immediately, which would delete cockpit.db before the readback below gets to
      // it; this test's own `finally` block owns that cleanup instead, once the readback is done.
      await launched.app.close().catch(() => {
        // Best-effort -- if the app already crashed/closed, there's nothing more to do (same as closeApp).
      })
      launched = undefined

      const output = runElectronAsNode(READ_SCRIPT, [userDataDir])
      const result = JSON.parse(output) as { columns: TableInfoColumn[]; rows: ArchiveMirrorRow[] }

      const pkColumnNames = result.columns
        .filter((c) => c.pk > 0)
        .map((c) => c.name)
        .sort()
      expect(pkColumnNames).toEqual(['dest_root', 'session_id'])

      // Lossless: both legacy rows survive the migration with every field intact.
      expect(result.rows).toEqual([
        {
          session_id: 'legacy-sess-1',
          dest_root: 'legacy-dest-root-a',
          synced_bytes: 42,
          meta_synced: 1,
          state: 'synced',
          last_error: null,
          updated_at: 1111
        },
        {
          session_id: 'legacy-sess-2',
          dest_root: 'legacy-dest-root-b',
          synced_bytes: 7,
          meta_synced: 0,
          state: 'error',
          last_error: 'pre-M7 legacy error',
          updated_at: 2222
        }
      ])
    } finally {
      if (launched) await closeApp(launched)
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  })
})
