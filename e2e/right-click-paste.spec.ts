// Right-click on a pane's terminal pastes the clipboard into the running pty (usePtyPane's contextmenu
// handler), while the session is not in mouse-tracking mode -- fake-claude never enables it.
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupFakeClaudeTranscripts,
  closeApp,
  launchApp,
  readPaneTerminalText,
  rmDirWithRetry,
  useFakeClaude
} from './fixtures/electronApp'

test('right-clicking the terminal pastes the clipboard text into the pty', async () => {
  test.setTimeout(90_000)
  const launched = await launchApp()
  const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-rclick-cwd-'))

  try {
    const { app, window: page } = launched
    await useFakeClaude(page)

    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () =>
        Promise.resolve({ canceled: false, filePaths: [dir] } as Electron.OpenDialogReturnValue)
    }, scratchCwd)
    await page.locator('button:has-text("フォルダ選択")').first().click()
    await expect(page.locator('.pane-cwd').first()).toHaveText(scratchCwd)
    await page.locator('button:has-text("＋ 新規セッション")').first().click()
    await page.locator('#purpose-dialog-text').fill(`rclick-purpose-${Date.now()}`)
    await page.locator('.dialog-row__primary').click()
    await expect(page.locator('.pane-header button:has-text("停止")').first()).toBeVisible()

    const clipText = `rclick-pasted-${Date.now()}`
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipText)
    await page.locator('.pane-terminal').first().click({ button: 'right' })

    await expect
      .poll(() => readPaneTerminalText(page, 0), {
        timeout: 10_000,
        message: '右クリックで貼り付けたテキストが端末に表示されるまで待機'
      })
      .toContain(clipText)
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
