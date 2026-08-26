// M13 (ADR-0015): the pane-local dictation textbox below each terminal. Exercises R-1 (always present,
// one per pane), R-7 (disabled until a session is running, and sends only to its own pane's pty), R-3/R-4
// (Enter submits through the real Terminal.paste()/input('\r') -> pty.write path, ending up in the
// archived transcript, same as e2e/app.spec.ts:173-210's "type directly into the terminal" flow), and
// R-5/D-6 (Ctrl+Enter inserts without a trailing CR, so fake-claude never sees a completed line).
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  archivedTranscriptPath,
  cleanupFakeClaudeTranscripts,
  closeApp,
  launchApp,
  readPaneTerminalText,
  rmDirWithRetry,
  useFakeClaude,
  type LaunchedApp
} from './fixtures/electronApp'

const PANE_HEADER_FOLDER_BUTTON = 'button:has-text("フォルダ選択")'
const PANE_HEADER_NEW_SESSION_BUTTON = 'button:has-text("＋ 新規セッション")'

test.describe('dictation input box (no claude CLI needed)', () => {
  let launched: LaunchedApp

  test.beforeEach(async () => {
    launched = await launchApp()
  })

  test.afterEach(async () => {
    await closeApp(launched)
  })

  test('a never-started pane has a disabled dictation box with a reason placeholder (R-7/D-5)', async () => {
    const page = launched.window
    const box = page.locator('.pane-dictation').first()
    await expect(box).toBeVisible()
    await expect(box).toBeDisabled()
    await expect(box).toHaveAttribute('placeholder', /セッション/)
  })

  test('every pane has its own dictation box, always attached regardless of layout (R-1/R-2)', async () => {
    const page = launched.window
    // R-1: one per pane, all 4 attached at once (PaneGrid keeps every Pane mounted; layout only toggles
    // CSS visibility -- see PaneGrid.tsx), not a single shared box.
    await expect(page.locator('.pane-dictation')).toHaveCount(4)

    await page.click('.layout-switcher__button:has-text("4分割")')
    await expect(page.locator('.pane-dictation')).toHaveCount(4)
    await page.click('.layout-switcher__button:has-text("2分割")')
    await expect(page.locator('.pane-dictation')).toHaveCount(4)
    await page.click('.layout-switcher__button:has-text("1")')
    await expect(page.locator('.pane-dictation')).toHaveCount(4)
  })
})

test.describe('full flow with fake claude: dictation box sends text into the real pty', () => {
  test('typing + Enter reaches the archived transcript; Ctrl+Enter inserts without submitting', async () => {
    test.setTimeout(90_000)
    const launched = await launchApp()
    const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-dictation-cwd-'))
    const purposeText = `E2E口述テスト目的-${Date.now()}`
    const dictationBox = launched.window.locator('.pane-dictation').first()

    try {
      const { app, window: page } = launched
      await useFakeClaude(page)

      let sessionId = ''
      await test.step('start a session (folder + purpose dialog)', async () => {
        await app.evaluate(({ dialog }, dir) => {
          dialog.showOpenDialog = () =>
            Promise.resolve({ canceled: false, filePaths: [dir] } as Electron.OpenDialogReturnValue)
        }, scratchCwd)
        await page.locator(PANE_HEADER_FOLDER_BUTTON).first().click()
        await expect(page.locator('.pane-cwd').first()).toHaveText(scratchCwd)

        await page.locator(PANE_HEADER_NEW_SESSION_BUTTON).first().click()
        await page.locator('#purpose-dialog-text').fill(purposeText)
        await page.locator('.dialog-row__primary').click()
        await expect(page.locator('.pane-header button:has-text("停止")').first()).toBeVisible()

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

      await test.step('dictation box is enabled once the pty is running (R-7)', async () => {
        await expect(dictationBox).toBeEnabled()
      })

      const dictatedMessage = `dictated message ${Date.now()}`
      await test.step('typing into the dictation box and pressing Enter submits (R-3/R-4)', async () => {
        await dictationBox.fill(dictatedMessage)
        await dictationBox.press('Enter')

        // R-6: the box empties on submit and keeps focus (so a second dictation could follow immediately).
        await expect(dictationBox).toHaveValue('')
        await expect(dictationBox).toBeFocused()

        // Bytes travel through the real Terminal.paste()/input('\r') -> term.onData -> pty.write path
        // (ADR-0015 D-1), so fake-claude's real reply proves the full round trip, exactly like
        // e2e/app.spec.ts's "type directly into the terminal" flow.
        await expect
          .poll(() => readPaneTerminalText(page, 0), {
            timeout: 10_000,
            message: '口述入力への応答が端末に表示されるまで待機'
          })
          .toContain(`了解しました（フェイク応答）: ${dictatedMessage}`)
      })

      await test.step('a layout switch does not remove the box, and it still sends afterward (R-1/D-3)', async () => {
        await page.click('.layout-switcher__button:has-text("4分割")')
        await expect(page.locator('.pane-dictation')).toHaveCount(4)
        await page.click('.layout-switcher__button:has-text("1")')
        await expect(dictationBox).toBeVisible()
        await expect(dictationBox).toBeEnabled()

        const secondMessage = `dictated after layout switch ${Date.now()}`
        await dictationBox.fill(secondMessage)
        await dictationBox.press('Enter')
        await expect
          .poll(() => readPaneTerminalText(page, 0), {
            timeout: 10_000,
            message: 'レイアウト切替後の口述応答が端末に表示されるまで待機'
          })
          .toContain(`了解しました（フェイク応答）: ${secondMessage}`)
      })

      await test.step('Ctrl+Enter inserts the text without a trailing CR, so it never becomes a turn (R-5/D-6)', async () => {
        const ctrlEnterTag = `ctrlenter-only-${Date.now()}`
        await dictationBox.fill(ctrlEnterTag)
        await dictationBox.press('Control+Enter')

        // R-6: still clears/keeps focus even for the insert-only path.
        await expect(dictationBox).toHaveValue('')

        // Proves the text really reached the pty (paste happened)...
        await expect
          .poll(() => readPaneTerminalText(page, 0), {
            timeout: 10_000,
            message: 'Ctrl+Enterで挿入したテキストが端末に表示されるまで待機'
          })
          .toContain(ctrlEnterTag)

        // ...but, unlike the two Enter-submitted messages above, no reply ever appears for it (fake-claude
        // only completes a turn once it sees a line-ending byte in its stdin, which `input('\r')` alone
        // supplies and Ctrl+Enter deliberately withholds).
        await page.waitForTimeout(2000)
        expect(await readPaneTerminalText(page, 0)).not.toContain(
          `了解しました（フェイク応答）: ${ctrlEnterTag}`
        )
      })

      await test.step('the archived transcript has the two submitted messages but not the Ctrl+Enter-only text', async () => {
        // Give the archiver's chokidar-polling sync (100ms interval + awaitWriteFinish) a moment to catch up.
        await page.waitForTimeout(1500)
        const archivedTranscript = fs.readFileSync(
          archivedTranscriptPath(launched.userDataDir, sessionId),
          'utf-8'
        )
        expect(archivedTranscript).toContain(dictatedMessage)
        expect(archivedTranscript).toContain('layout switch')
        expect(archivedTranscript).not.toContain('ctrlenter-only')
      })
    } finally {
      // Close the app (and thus kill the fake-claude pty, via before-quit's ptyManager.killAll()) *before*
      // removing the scratch cwd -- Windows holds an exclusive lock on a directory that's still a running
      // process's cwd, so removing it first (observed empirically) fails with EPERM. Wrapped in its own
      // try/catch so a cleanup failure (e.g. `rmDirWithRetry` finally giving up) is logged rather than
      // replacing/hiding whatever assertion failure the `try` block above may have thrown -- per JS
      // semantics, a `finally` block that itself throws discards the original error. Matches
      // e2e/app.spec.ts's established convention for this exact race.
      try {
        await closeApp(launched)
        await rmDirWithRetry(scratchCwd)
        cleanupFakeClaudeTranscripts()
      } catch (cleanupErr) {
        console.error('post-test cleanup failed:', cleanupErr)
      }
    }
  })

  test('a pane only sends to its own pty: pane 1 dictation reaches pane 1, never pane 0 (R-7)', async () => {
    test.setTimeout(90_000)
    const launched = await launchApp()
    const scratchCwd0 = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-dictation-cwd0-'))
    const scratchCwd1 = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-dictation-cwd1-'))

    try {
      const { app, window: page } = launched
      await useFakeClaude(page)

      // Scoped by `.pane-slot` (not a flat page-wide `nth()` over button text) -- once pane 0's session is
      // running, its "＋ 新規セッション" button is replaced by "停止" (Pane.tsx), which would shift a flat
      // `nth(1)` search for that button text onto pane 2 instead of pane 1. Scoping under each pane's own
      // `.pane-slot` keeps "pane N's control" meaning exactly that regardless of any other pane's state.
      const paneSlot = (n: number): ReturnType<typeof page.locator> =>
        page.locator('.pane-slot').nth(n)

      await test.step('switch to 4-pane layout and start sessions on pane 0 and pane 1', async () => {
        await page.click('.layout-switcher__button:has-text("4分割")')

        await app.evaluate(({ dialog }, dir) => {
          dialog.showOpenDialog = () =>
            Promise.resolve({ canceled: false, filePaths: [dir] } as Electron.OpenDialogReturnValue)
        }, scratchCwd0)
        await paneSlot(0).locator(PANE_HEADER_FOLDER_BUTTON).click()
        await expect(paneSlot(0).locator('.pane-cwd')).toHaveText(scratchCwd0)
        await paneSlot(0).locator(PANE_HEADER_NEW_SESSION_BUTTON).click()
        await page.locator('#purpose-dialog-text').fill(`pane0-purpose-${Date.now()}`)
        await page.locator('.dialog-row__primary').click()
        await expect(paneSlot(0).locator('.pane-header button:has-text("停止")')).toBeVisible()

        await app.evaluate(({ dialog }, dir) => {
          dialog.showOpenDialog = () =>
            Promise.resolve({ canceled: false, filePaths: [dir] } as Electron.OpenDialogReturnValue)
        }, scratchCwd1)
        await paneSlot(1).locator(PANE_HEADER_FOLDER_BUTTON).click()
        await expect(paneSlot(1).locator('.pane-cwd')).toHaveText(scratchCwd1)
        await paneSlot(1).locator(PANE_HEADER_NEW_SESSION_BUTTON).click()
        await page.locator('#purpose-dialog-text').fill(`pane1-purpose-${Date.now()}`)
        await page.locator('.dialog-row__primary').click()
        await expect(paneSlot(1).locator('.pane-header button:has-text("停止")')).toBeVisible()

        await expect(paneSlot(0).locator('.pane-dictation')).toBeEnabled()
        await expect(paneSlot(1).locator('.pane-dictation')).toBeEnabled()
      })

      await test.step("sending from pane 1's dictation box reaches only pane 1 (never pane 0)", async () => {
        const pane1Message = `pane1-only-${Date.now()}`
        await paneSlot(1).locator('.pane-dictation').fill(pane1Message)
        await paneSlot(1).locator('.pane-dictation').press('Enter')

        await expect
          .poll(() => readPaneTerminalText(page, 1), {
            timeout: 10_000,
            message: 'pane1への口述応答が端末に表示されるまで待機'
          })
          .toContain(`了解しました（フェイク応答）: ${pane1Message}`)

        // R-7 (ADR-0015 D-4): the wiring is per-pane, not a shared/"active pane" destination -- pane 0's
        // terminal must never see pane 1's dictated text or reply.
        expect(await readPaneTerminalText(page, 0)).not.toContain(pane1Message)
      })

      await test.step("sending from pane 0's dictation box reaches only pane 0 (reverse direction)", async () => {
        const pane0Message = `pane0-only-${Date.now()}`
        await paneSlot(0).locator('.pane-dictation').fill(pane0Message)
        await paneSlot(0).locator('.pane-dictation').press('Enter')

        await expect
          .poll(() => readPaneTerminalText(page, 0), {
            timeout: 10_000,
            message: 'pane0への口述応答が端末に表示されるまで待機'
          })
          .toContain(`了解しました（フェイク応答）: ${pane0Message}`)

        expect(await readPaneTerminalText(page, 1)).not.toContain(pane0Message)
      })
    } finally {
      // Same rationale/ordering as the finally block above (closeApp before removing either scratch cwd;
      // cleanup errors logged, never thrown, so they cannot mask a real assertion failure from the `try`
      // block) -- doubled here since this test spawns two ptys, one per scratch cwd.
      try {
        await closeApp(launched)
        await rmDirWithRetry(scratchCwd0)
        await rmDirWithRetry(scratchCwd1)
        cleanupFakeClaudeTranscripts()
      } catch (cleanupErr) {
        console.error('post-test cleanup failed:', cleanupErr)
      }
    }
  })
})
