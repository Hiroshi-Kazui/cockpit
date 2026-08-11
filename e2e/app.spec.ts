// M5 primary E2E suite (Playwright + Electron, spec §4.1/§4.2/§4.4). Two groups:
//   1. "app shell" -- no claude CLI involved at all (layout switch, session browser open/close read-only
//      UI, keyboard pane-focus shortcuts). Always runs.
//   2. "full flow with fake claude" -- exercises 起動 -> セッション開始 -> 記録 -> 閲覧 end-to-end against
//      the E2E fake-claude fixture (e2e/fixtures/fake-claude.js) rather than a real claude CLI, so it
//      never depends on network access, an authenticated claude account, or token spend. Every app-side
//      module under test (resolveClaude, PtyManager, the telemetry pipe, SessionCoordinator, the
//      archiver, sessionRepo's list/search, the archive reader, and the SessionBrowser UI) is completely
//      real and unmodified -- only the external CLI process itself is faked. See fake-claude.js's header
//      comment for exactly what it replicates of the real statusLine/transcript contract, and the M5
//      completion report for why TD-1's "does the real Claude Code TUI's statusLine fire before the
//      user's first interaction" question specifically cannot be settled by this fake (it requires the
//      real binary).
//
// NOTE: the destructured Playwright window object is deliberately bound to a local named `page` (not
// `window`) everywhere below -- see electronApp.ts's useFakeClaude doc comment for why naming it `window`
// would shadow the ambient DOM `Window` global inside any `page.evaluate(() => window....)` callback.
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  archivedTranscriptPath,
  cleanupFakeClaudeTranscripts,
  closeApp,
  focusPaneTerminal,
  launchApp,
  readPaneTerminalText,
  rmDirWithRetry,
  useFakeClaude,
  type LaunchedApp
} from './fixtures/electronApp'

const PANE_HEADER_FOLDER_BUTTON = 'button:has-text("フォルダ選択")'
const PANE_HEADER_NEW_SESSION_BUTTON = 'button:has-text("＋ 新規セッション")'

test.describe('cockpit app shell (no claude CLI needed)', () => {
  let launched: LaunchedApp

  test.beforeEach(async () => {
    launched = await launchApp()
  })

  test.afterEach(async () => {
    await closeApp(launched)
  })

  test('launches, shows the 4-pane grid, and switches layouts without error', async () => {
    const page = launched.window
    await expect(page.locator('.app-header h1')).toHaveText('cockpit')
    await expect(page.locator('.pane-slot')).toHaveCount(4)

    await page.click('.layout-switcher__button:has-text("4分割")')
    await expect(page.locator('.pane-grid')).toHaveClass(/pane-grid--split4/)

    await page.click('.layout-switcher__button:has-text("2分割")')
    await expect(page.locator('.pane-grid')).toHaveClass(/pane-grid--split2/)

    await page.click('.layout-switcher__button:has-text("1")')
    await expect(page.locator('.pane-grid')).toHaveClass(/pane-grid--single/)
  })

  test('opens and closes the read-only session browser, with no edit/delete controls anywhere in it', async () => {
    const page = launched.window
    await page.click('button:has-text("過去セッション")')
    const browser = page.locator('.session-browser')
    await expect(browser).toBeVisible()

    // AC "閲覧は読み取り専用。アーカイブへの編集・削除UIが存在しない": scan every button label rendered
    // inside the browser for anything resembling an edit/delete affordance.
    const buttonTexts = await browser.locator('button').allTextContents()
    for (const text of buttonTexts) {
      expect(text).not.toMatch(/編集|削除|delete|edit|rename|リネーム/i)
    }

    await page.keyboard.press('Escape')
    await expect(browser).toHaveCount(0)
  })

  test('Ctrl+1..4 moves keyboard focus between visible panes, and is a no-op for a hidden pane', async () => {
    const page = launched.window
    await page.click('.layout-switcher__button:has-text("4分割")')

    const activePaneIndex = (): Promise<number | null> =>
      page.evaluate(() => {
        const el = document.activeElement
        const slot = el?.closest('.pane-slot') ?? null
        if (!slot) return null
        return Array.from(document.querySelectorAll('.pane-slot')).indexOf(slot)
      })

    await focusPaneTerminal(page, 0)
    await expect.poll(activePaneIndex).toBe(0)

    await page.keyboard.press('Control+3')
    await expect.poll(activePaneIndex).toBe(2)

    await page.keyboard.press('Control+1')
    await expect.poll(activePaneIndex).toBe(0)

    // Now switch to 'single' layout (only pane 0 visible) and confirm Ctrl+3 is a no-op.
    await page.click('.layout-switcher__button:has-text("1")')
    await focusPaneTerminal(page, 0)
    await expect.poll(activePaneIndex).toBe(0)
    await page.keyboard.press('Control+3')
    await expect.poll(activePaneIndex).toBe(0)
  })
})

test.describe('full flow with fake claude: 起動 -> セッション開始 -> 記録 -> 閲覧', () => {
  test('starts a session, survives a layout switch, archives the transcript, and shows it read-only in the browser', async () => {
    test.setTimeout(90_000)
    const launched = await launchApp()
    const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-cwd-'))
    const purposeText = `E2Eテスト目的-${Date.now()}`

    try {
      const { app, window: page } = launched
      await useFakeClaude(page)

      await test.step('folder select + 新規セッション dialog confirm spawns fake-claude', async () => {
        // Native dialog.showOpenDialog cannot be driven by Playwright -- stub it in the main process to
        // resolve with our scratch cwd, then drive the *real* "フォルダ選択" button/handler as a user
        // would (see electronApp.ts's header comment for why this is preferred over reaching around the
        // IPC/React-state boundary directly).
        await app.evaluate(({ dialog }, dir) => {
          dialog.showOpenDialog = () =>
            Promise.resolve({ canceled: false, filePaths: [dir] } as Electron.OpenDialogReturnValue)
        }, scratchCwd)
        await page.locator(PANE_HEADER_FOLDER_BUTTON).first().click()
        await expect(page.locator('.pane-cwd').first()).toHaveText(scratchCwd)

        await page.locator(PANE_HEADER_NEW_SESSION_BUTTON).first().click()
        await page.locator('#purpose-dialog-text').fill(purposeText)
        await page.locator('.dialog-row__primary').click()

        // `running` flips true once paneLaunch.start's IPC round-trip resolves (usePtyPane's `start`).
        await expect(page.locator('.pane-header button:has-text("停止")').first()).toBeVisible()
      })

      let sessionId = ''
      await test.step('session gets linked+archived (statusLine primary signal, TD-1) and appears in the SQLite index', async () => {
        // Identify the row by its purpose text (not `rows[0]`, which assumes a single session and an
        // unverified ordering) -- this is the one session running in this test's isolated --user-data-dir,
        // but matching on its own purpose text keeps the identification robust regardless of list order.
        await expect
          .poll(
            async () => {
              const rows = await page.evaluate(
                (text) => window.cockpit.archive.listSessions({ searchText: text }),
                purposeText
              )
              const match = rows.find((row) => row.purpose === purposeText)
              if (match) sessionId = match.id
              return match !== undefined
            },
            { timeout: 20_000, message: '目的テキストでセッションが索引されるまで待機' }
          )
          .toBe(true)
      })

      await test.step('layout switch does not kill the running session (AC: レイアウト切替時にペイン内容が壊れない)', async () => {
        await page.click('.layout-switcher__button:has-text("4分割")')
        await expect(page.locator('.pane-header button:has-text("停止")').first()).toBeVisible()
        await page.click('.layout-switcher__button:has-text("2分割")')
        await expect(page.locator('.pane-header button:has-text("停止")').first()).toBeVisible()
        await page.click('.layout-switcher__button:has-text("1")')
        await expect(page.locator('.pane-header button:has-text("停止")').first()).toBeVisible()

        // Prove the pty is still genuinely alive (not just that the UI forgot to notice it died): send a
        // second real message through the actual xterm.js terminal and confirm fake-claude replies.
        await focusPaneTerminal(page, 0)
        await page.keyboard.type('second message after layout switch')
        await page.keyboard.press('Enter')
        // The canvas renderer (see usePtyPane.ts) paints to a <canvas>, never to the DOM, so this reads
        // xterm's own buffer (via the E2E-only `window.__cockpitTestHooks` observation point) rather than
        // `.pane-terminal`'s (permanently empty) `textContent`. Asserts on the reply text specific to *this*
        // message (not just the shared "了解しました" prefix) -- fake-claude's fixed startup banner already
        // contains "了解しました" nowhere, but the first turn's own reply (also present in scrollback) does
        // share that prefix, so matching the full reply is what actually proves this second message got a
        // reply, not that some earlier reply is still sitting in the buffer.
        await expect
          .poll(() => readPaneTerminalText(page, 0), {
            timeout: 10_000,
            message: '2通目のメッセージへの応答がターミナルに表示されるまで待機'
          })
          .toContain('了解しました（フェイク応答）: second message after layout switch')
      })

      await test.step('open the read-only session browser, search, and view the archived transcript', async () => {
        // Give the archiver's chokidar-polling sync (100ms interval + awaitWriteFinish) a moment to catch
        // up on the second message appended above, so both turns are present in the archived copy.
        await page.waitForTimeout(1500)

        await page.click('button:has-text("過去セッション")')
        // Search by a purpose-text prefix (spec §4.4 "検索": purpose/title/cwd 部分一致) -- the list
        // item itself displays the *title* (fake-claude's headless -p mode always returns the same fixed
        // title, "E2Eフェイクタイトル", regardless of purpose text, matching Pane.tsx's own
        // title-priority display convention), so this also exercises "search matches on purpose even
        // when title differs from it", not just an exact-substring-of-the-displayed-label match.
        await page.locator('input[aria-label="セッション検索"]').fill(purposeText.slice(0, 10))
        const items = page.locator('.session-browser__item')
        await expect(items).toHaveCount(1, { timeout: 10_000 })
        await expect(items.first()).toContainText('E2Eフェイクタイトル')
        await items.first().click()

        const transcript = page.locator('.session-browser__transcript')
        await expect(transcript).toContainText(purposeText, { timeout: 10_000 })
        await expect(transcript).toContainText('了解しました（フェイク応答）', { timeout: 10_000 })
        await expect(transcript).toContainText('second message after layout switch')

        // Read-only: confirm no edit/delete affordance anywhere in the whole app while a session is open
        // in the browser.
        const buttonTexts = await page.locator('.session-browser button').allTextContents()
        for (const text of buttonTexts) {
          expect(text).not.toMatch(/編集|削除|delete|edit|rename|リネーム/i)
        }
      })

      await test.step('M10 line retention: the archived transcript keeps human/assistant turns and retained attachment lines, but discards machine-noise ones (spec §4.4/ADR-0011)', async () => {
        // Read the app-managed archive copy directly (not the SessionBrowser UI, which only ever renders
        // human/assistant turns regardless of retention -- reading raw bytes is what actually proves M10's
        // retention policy discarded the noise line, not merely that the UI doesn't display attachments).
        const archivedTranscript = fs.readFileSync(
          archivedTranscriptPath(launched.userDataDir, sessionId),
          'utf-8'
        )
        expect(archivedTranscript).toContain(purposeText)
        expect(archivedTranscript).toContain('了解しました（フェイク応答）')
        // fake-claude.js emits one `attachment.type:"hook_success"` line (pure machine-generated noise,
        // ADR-0011/R-3) before any human turn -- proves shared/archiveRetention.ts's `shouldRetainLine`
        // discarded it, identified by the discriminator field the policy itself keys on (not an artificial
        // marker string).
        expect(archivedTranscript).not.toContain('hook_success')
        // ...and one `attachment.type:"queued_command"` line (D-3a: the one attachment type retained,
        // since it is the only record of a human interrupting a running agent turn) -- proves retention is
        // selective in both directions, not just "discards everything under type:attachment".
        expect(archivedTranscript).toContain('queued_command')
      })
    } finally {
      // Close the app (and thus kill the fake-claude pty, via before-quit's ptyManager.killAll()) *before*
      // removing the scratch cwd -- Windows holds an exclusive lock on a directory that's still a running
      // process's cwd, so removing it first (observed empirically) fails with EPERM. Wrapped in its own
      // try/catch so a cleanup failure (e.g. `rmDirWithRetry` finally giving up) is logged rather than
      // replacing/hiding whatever assertion failure the `try` block above may have thrown -- per JS
      // semantics, a `finally` block that itself throws discards the original error.
      try {
        await closeApp(launched)
        await rmDirWithRetry(scratchCwd)
        cleanupFakeClaudeTranscripts()
      } catch (cleanupErr) {
        console.error('post-test cleanup failed:', cleanupErr)
      }
    }
  })
})

// M12 (ADR-0014): ptyManager.spawn() now hosts every pty on node-pty's bundled conpty.dll
// (useConptyDll: true) instead of the OS conhost-hosted ConPTY. useConptyDll changes node-pty's own
// kill()/exit-code plumbing internally (windowsPtyAgent.js's `_useConptyDll` branches, cited in
// windowsPtyInfo.ts), so this pins that the exit notice usePtyPane.ts writes on a real pty exit still
// reaches the terminal under the new backend -- not just that the process dies.
test.describe('pty exit notice under the bundled ConPTY (M12, ADR-0014)', () => {
  test('stopping a running session writes the exit notice into the pane', async () => {
    test.setTimeout(60_000)
    const launched = await launchApp()
    const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-cwd-'))

    try {
      const { app, window: page } = launched
      await useFakeClaude(page)

      await app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = () =>
          Promise.resolve({ canceled: false, filePaths: [dir] } as Electron.OpenDialogReturnValue)
      }, scratchCwd)
      await page.locator(PANE_HEADER_FOLDER_BUTTON).first().click()
      await expect(page.locator('.pane-cwd').first()).toHaveText(scratchCwd)

      await page.locator(PANE_HEADER_NEW_SESSION_BUTTON).first().click()
      await page.locator('#purpose-dialog-text').fill(`E2E終了通知-${Date.now()}`)
      await page.locator('.dialog-row__primary').click()
      const stopButton = page.locator('.pane-header button:has-text("停止")').first()
      await expect(stopButton).toBeVisible()

      await stopButton.click()
      await expect
        .poll(async () => await readPaneTerminalText(page, 0), {
          timeout: 15_000,
          message: '[claude exited: code=...] の終了通知が端末バッファに現れるまで待機'
        })
        .toMatch(/\[claude exited: code=\d+\]/)
    } finally {
      try {
        await closeApp(launched)
        await rmDirWithRetry(scratchCwd)
        cleanupFakeClaudeTranscripts()
      } catch (cleanupErr) {
        console.error('post-test cleanup failed:', cleanupErr)
      }
    }
  })
})
