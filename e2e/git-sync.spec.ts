// M11 E2E: the git working-tree sync attempted on "＋ 新規セッション" launch (spec §4.2 addendum,
// ADR-0013). Uses a real `git init`-created fixture repository -- no remote is ever configured, so
// default-branch resolution exercises D-5's local `main`/`master` fallback rule and this whole suite
// needs no network access at all -- plus the existing fake-claude fixture so the pty/session-linking side
// of the flow is exercised for real (mirrors app.spec.ts's "full flow" group).
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupFakeClaudeTranscripts,
  closeApp,
  launchApp,
  rmDirWithRetry,
  useFakeClaude
} from './fixtures/electronApp'

const PANE_HEADER_FOLDER_BUTTON = 'button:has-text("フォルダ選択")'
const PANE_HEADER_NEW_SESSION_BUTTON = 'button:has-text("＋ 新規セッション")'

// Main-process-global bridge used only by the dirty-case test below to observe that
// `dialog.showMessageBox` was actually invoked (and with what body) -- `app.evaluate` calls are separate
// RPC round-trips into the same long-lived Electron main process, so a plain `globalThis` property set by
// one call is still readable by a later one (unlike a Node-side closure variable, which cannot cross the
// process boundary at all).

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

/** Creates a fixture repo with an initial commit on `main`, then checks out `feature` (leaving `main` as
 * the target D-5's local fallback rule resolves to -- no remote is ever configured here). The branch name
 * is forced via `symbolic-ref` rather than relying on `git init -b`/`init.defaultBranch`, so this doesn't
 * depend on the test-running machine's git version or global config. */
function makeFixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-gitrepo-'))
  git(dir, ['init'])
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(dir, ['config', 'user.email', 'cockpit-e2e@example.com'])
  git(dir, ['config', 'user.name', 'cockpit e2e'])
  fs.writeFileSync(path.join(dir, 'README.md'), 'initial\n', 'utf-8')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-m', 'initial commit'])
  git(dir, ['checkout', '-b', 'feature'])
  return dir
}

test.describe('M11 git sync on new-session launch (spec §4.2 addendum, ADR-0013)', () => {
  test('clean case: starting from a non-default branch switches to the local default branch', async () => {
    test.setTimeout(60_000)
    const launched = await launchApp()
    const repoDir = makeFixtureRepo()

    try {
      const { app, window: page } = launched
      await useFakeClaude(page)

      // Native dialog.showOpenDialog cannot be driven by Playwright -- stub it to resolve with the
      // fixture repo, then drive the real "フォルダ選択" button as a user would (see electronApp.ts's
      // useFakeClaude doc comment / app.spec.ts's identical precedent).
      await app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = () =>
          Promise.resolve({ canceled: false, filePaths: [dir] } as Electron.OpenDialogReturnValue)
      }, repoDir)
      await page.locator(PANE_HEADER_FOLDER_BUTTON).first().click()
      await expect(page.locator('.pane-cwd').first()).toHaveText(repoDir)

      expect(git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature')

      await page.locator(PANE_HEADER_NEW_SESSION_BUTTON).first().click()
      await page.locator('#purpose-dialog-text').fill('M11 E2Eテスト目的（clean）')
      await page.locator('.dialog-row__primary').click()

      // `running` flips true once paneLaunch.start's IPC round-trip resolves (usePtyPane's `start`) --
      // which now only happens *after* the git sync has run (purposeCoordinator.ts awaits prepareRepo
      // before spawning), so this assertion alone already proves the sync completed before launch.
      await expect(page.locator('.pane-header button:has-text("停止")').first()).toBeVisible({
        timeout: 20_000
      })

      // R-8: the notification row reports the branch move (never a modal for a plain successful sync).
      await expect(page.locator('.pane-repo-sync').first()).toContainText('main', {
        timeout: 20_000
      })

      expect(git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main')
    } finally {
      try {
        await closeApp(launched)
        await rmDirWithRetry(repoDir)
        cleanupFakeClaudeTranscripts()
      } catch (cleanupErr) {
        console.error('post-test cleanup failed:', cleanupErr)
      }
    }
  })

  test('dirty case: an uncommitted file blocks the branch move (native alert) but the session still starts and is recorded', async () => {
    test.setTimeout(60_000)
    const launched = await launchApp()
    const repoDir = makeFixtureRepo()
    fs.writeFileSync(path.join(repoDir, 'untracked.txt'), 'oops\n', 'utf-8')
    const purposeText = `M11 E2Eテスト目的（dirty）-${Date.now()}`

    try {
      const { app, window: page } = launched
      await useFakeClaude(page)

      await app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = () =>
          Promise.resolve({ canceled: false, filePaths: [dir] } as Electron.OpenDialogReturnValue)
      }, repoDir)
      await page.locator(PANE_HEADER_FOLDER_BUTTON).first().click()
      await expect(page.locator('.pane-cwd').first()).toHaveText(repoDir)

      // Stub the "commit を促す" native alert (dialog.showMessageBox, ADR-0013/D-9) -- a real modal has
      // no user to click it in this headless run. Records every call's body on a main-process global so
      // this test can prove it was actually invoked (R-3), not just infer it from side effects.
      await app.evaluate(({ dialog }) => {
        const g = globalThis as unknown as { __cockpitE2EMessageBoxDetails: string[] }
        g.__cockpitE2EMessageBoxDetails = []
        dialog.showMessageBox = ((..._args: unknown[]) => {
          const opts = _args[_args.length - 1] as { detail?: string; message?: string }
          g.__cockpitE2EMessageBoxDetails.push(opts.detail ?? opts.message ?? '')
          return Promise.resolve({ response: 0, checkboxChecked: false })
        }) as typeof dialog.showMessageBox
      })

      await page.locator(PANE_HEADER_NEW_SESSION_BUTTON).first().click()
      await page.locator('#purpose-dialog-text').fill(purposeText)
      await page.locator('.dialog-row__primary').click()

      // R-9: git being blocked must never prevent the session from starting.
      await expect(page.locator('.pane-header button:has-text("停止")').first()).toBeVisible({
        timeout: 20_000
      })

      const messageBoxDetails = await app.evaluate(() => {
        const g = globalThis as unknown as { __cockpitE2EMessageBoxDetails?: string[] }
        return g.__cockpitE2EMessageBoxDetails ?? []
      })
      expect(messageBoxDetails.some((text) => text.includes('未コミット'))).toBe(true)
      expect(messageBoxDetails.some((text) => text.includes(repoDir))).toBe(true)

      // R-3: neither checkout nor pull ran -- the branch must still be the one the launch started on.
      expect(git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature')

      // R-8: the pane-local notification row also reflects the block (not just the modal).
      await expect(page.locator('.pane-repo-sync').first()).toContainText('未コミット')

      // FIX M11 (review iter1): a blocked git sync must not silently drop the session from the record
      // (spec §1/§4.4's core "起動・表示・記録" purpose) -- confirm it actually landed in the SQLite index,
      // not just that the "停止" button happened to render.
      await expect
        .poll(
          async () => {
            const rows = await page.evaluate(
              (text) => window.cockpit.archive.listSessions({ searchText: text }),
              purposeText
            )
            return rows.some((row) => row.purpose === purposeText)
          },
          {
            timeout: 20_000,
            message: '目的テキストでセッションが索引されるまで待機（dirty ケース）'
          }
        )
        .toBe(true)
    } finally {
      try {
        await closeApp(launched)
        await rmDirWithRetry(repoDir)
        cleanupFakeClaudeTranscripts()
      } catch (cleanupErr) {
        console.error('post-test cleanup failed:', cleanupErr)
      }
    }
  })
})
