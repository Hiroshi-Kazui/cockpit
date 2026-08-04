// End-to-end invariant (real node-pty/ConPTY, real xterm.js, real IPC): growing a pane's row count while
// claude is running must not disturb the terminal buffer, and a partial in-place frame repaint afterwards
// must land on the frame's own rows -- nothing of the previous frame may survive. That is the shape of the
// reported "スクロールすると表示が崩れ、左端の文字がその場に残る" artifact, and cockpit hits mid-session row
// changes routinely (a pane-header row appearing/disappearing, a window resize, a divider drag).
//
// Honest scope: this passes both with and without usePtyPane's `windowsPty` option, so it is NOT a
// regression test for that option -- the row-growth bookkeeping difference windowsPty fixes
// (main/pty/windowsPtyInfo.ts) is real but ConPTY's own repaint absorbed it in every scenario tried here.
// The reported artifact itself is still un-reproduced; this test exists so that if it ever *is* reproduced
// in this shape, it is caught here.
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  launchApp,
  closeApp,
  useFakeClaude,
  readPaneTerminalText,
  focusPaneTerminal,
  cleanupFakeClaudeTranscripts
} from './fixtures/electronApp'

/** Enough extra window height to grow the terminal by more than one row at fontSize 13. */
const GROW_BY_PX = 60

/** The buffer's actual content, ignoring how many blank rows pad it out (which legitimately changes with
 * the row count). */
function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

async function paint(
  page: Awaited<ReturnType<typeof launchApp>>['window'],
  tag: string,
  mode: 'clear' | 'keep'
): Promise<void> {
  await page.keyboard.type(`#paint ${tag} ${mode}`)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => await readPaneTerminalText(page, 0), {
      timeout: 15_000,
      message: `フレーム ${tag} が端末バッファに現れるまで待機`
    })
    .toContain(`${tag}3 行目です`)
}

test.describe('端末バッファの行整合（行数変化をまたぐ部分再描画）', () => {
  test('a mid-session row-count change leaves no line of the previous frame behind', async () => {
    test.setTimeout(90_000)
    const launched = await launchApp()
    const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-cwd-'))

    try {
      const { app, window: page } = launched
      await useFakeClaude(page)

      await app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = () =>
          Promise.resolve({ canceled: false, filePaths: [dir] } as Electron.OpenDialogReturnValue)
      }, scratchCwd)
      await page.locator('.pane-header button:has-text("フォルダ選択")').first().click()
      await expect(page.locator('.pane-cwd').first()).toHaveText(scratchCwd)

      const purposeText = `E2E再描画-${Date.now()}`
      await page.locator('.pane-header button:has-text("＋ 新規セッション")').first().click()
      await page.locator('#purpose-dialog-text').fill(purposeText)
      await page.locator('.dialog-row__primary').click()
      await expect(page.locator('.pane-header button:has-text("停止")').first()).toBeVisible()

      // The app types the purpose text into the pty itself once the session is ready (TD-1's
      // launch-readiness watcher). Wait for the fake CLI to have answered it, or that injected prompt
      // interleaves with the keystrokes below and both lines arrive garbled.
      await expect
        .poll(async () => await readPaneTerminalText(page, 0), {
          timeout: 20_000,
          message: 'TD-1 の目的プロンプト送信が完了するまで待機'
        })
        .toContain(`了解しました（フェイク応答）: ${purposeText}`)

      await focusPaneTerminal(page, 0)
      await paint(page, 'AAA', 'clear')
      const beforeGrowth = nonEmptyLines(await readPaneTerminalText(page, 0))

      // Grow the pane's row count while the pty is running, then let xterm's ResizeObserver -> fit() ->
      // pty.resize round-trip settle.
      await app.evaluate(({ BrowserWindow }, growBy) => {
        const win = BrowserWindow.getAllWindows()[0]
        const [width, height] = win.getSize()
        win.setSize(width, height + growBy)
      }, GROW_BY_PX)
      await page.waitForTimeout(1000)
      const afterGrowth = nonEmptyLines(await readPaneTerminalText(page, 0))

      // The growth itself must not change what the buffer holds. Without `windowsPty` xterm.js fills the
      // new rows by decrementing ybase/ydisp -- pulling already-scrolled-off lines back into the viewport --
      // while ConPTY adds blank rows at the bottom instead, so the two stop agreeing on which buffer row is
      // which. Observed concretely: the pre-frame "fake-claude ready" line reappears above the frame.
      expect(
        afterGrowth,
        '行数が増えた瞬間に、スクロールバックの行がビューポートへ引き戻されている（ConPTY 側は末尾に空行を足すだけなので行対応がずれる）'
      ).toEqual(beforeGrowth)

      // And a partial in-place repaint afterwards must land on the frame's own rows, leaving nothing of the
      // previous frame behind (the reported "左端の文字が残る" artifact would show up here).
      await paint(page, 'BBB', 'keep')
      const text = await readPaneTerminalText(page, 0)
      for (const n of [1, 2, 3]) {
        expect(text, `部分再描画のあとに前フレームの行 AAA${n} が残っている`).not.toContain(
          `AAA${n} 行目です`
        )
      }
    } finally {
      await closeApp(launched)
      fs.rmSync(scratchCwd, { recursive: true, force: true })
      cleanupFakeClaudeTranscripts()
    }
  })
})
