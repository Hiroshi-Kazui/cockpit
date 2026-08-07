// End-to-end invariant (real node-pty/ConPTY, real xterm.js, real IPC): growing a pane's row count while
// claude is running must not disturb the terminal buffer, and a partial in-place frame repaint afterwards
// must land on the frame's own rows -- nothing of the previous frame may survive. That is the shape of the
// reported "スクロールすると表示が崩れ、左端の文字がその場に残る" artifact, and cockpit hits mid-session row
// changes routinely (a pane-header row appearing/disappearing, a window resize, a divider drag).
//
// Honest scope of the first test: it passes both with and without usePtyPane's `windowsPty` option, so it
// is NOT a regression test for that option -- the row-growth bookkeeping difference windowsPty fixes
// (main/pty/windowsPtyInfo.ts) is real but ConPTY's own repaint absorbed it in every scenario tried here.
//
// The artifact was subsequently reproduced away from the app, with a real ConPTY driving a real xterm.js
// buffer: emitted text stays byte-identical when nothing resizes, and gets corrupted on every single run as
// soon as a resize happens mid-output -- rows duplicated, and cells of one row left inside another. Swapping
// the term.resize/pty.resize order does not help, because the disagreement is ConPTY's (it reprints its own
// view of the screen and still counts rows xterm.js has moved to scrollback as on-screen), not a race in
// cockpit. The app-side conclusion, covered by the two tests below: cockpit must not change a running pane's
// terminal size on its own, which it used to do every session as the pane's informational rows and context
// gauge appeared (now .pane-info / --pane-gauge-height, both constant-height).
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  launchApp,
  closeApp,
  useFakeClaude,
  readPaneTerminalText,
  readPaneTerminalGrid,
  focusPaneTerminal,
  cleanupFakeClaudeTranscripts
} from './fixtures/electronApp'

/** Enough extra window height to grow the terminal by more than one row at fontSize 13. */
const GROW_BY_PX = 60

/** The text the artifact was reported against, verbatim. Kept as-is rather than paraphrased because what
 * made it a good reproduction is its character mix: full-width CJK next to ASCII identifiers, East Asian
 * Ambiguous punctuation (→ ・ （） ／ ①②), and long lines that wrap. */
const REPORTED_MATERIAL = `レビュー（Opus）

- Step 1: csharp + database → CRITICAL 1 / HIGH 4 / MEDIUM 13 → CRITICAL・HIGH 全件対応
  - Step 2: csharp → HIGH 2（DST 経路で待機時間が負になり得る／DST 未検証）→ 全件対応
  - Step 3+4+5: csharp + silent-failure-hunter → CRITICAL 2（① 失敗した件の行が次の件のトランザクションで commit される DbContext 汚染 ② 無人バッチの停止が INFO ログに埋もれる）/ HIGH 7 → 全件対応
  - 分類 A の Step 3+4 で security-reviewer と database-reviewer を起動せず 2 レーンに絞りました（HTTP 経路・外部入力・シークレットなし、DB 変更は既存 StartAtomicAsync と同型の 12 行）。認可不在の観点は csharp レーンに明示指示済み

プランにない追加変更（レビュー指摘由来）

  - schedule(planned_start) の partial index + マイグレーション（無索引で毎晩全件スキャン + 全件ソートになる指摘）
  - SubmitExistingAtomicAsync の activation 重複除外（本機能が提出前に activation を張るため、Submit 以外がルートのワークフローで提出が 500 になる経路を予防）

メインが直接修正した範囲（Opus レビュー未通過）

  Take の SQL 残置・ID 型の再ラップ・Parse の FormatProvider・null 免除演算子・record の不正な constructor 構文・関数長/複雑度の分割・activated_at の UTC 正規化・FK が無い列を失敗源にしていた原子性テストの作り直し・DST テスト追加

Remaining Risks / Follow-ups

1. 初回一斉活性化: 現 dev DB の対象は 1595 件（実測）。MaxPerRun=200 + 即時再周回上限 5 で 1 起床あたり最大 1000 件が IN_PROGRESS になります。本番投入前に ActivateFrom（開始日の下限）を設けるか Enabled=false で入れるかの判断が必要です
2. OwnerAssignmentId が null のため、バッチ活性化した成果品は提出後にホーム一覧から落ちます（手動着手との差）。修正には提出時に owner を埋める変更（StartDeliverableUseCase + Domain）が必要で、誰を owner にするかは業務判断
3. deliverable の (project_deliverable_id, attempt_number) UNIQUE は未追加（既存データ監査と ADR が必要）。二重活性化はトランザクション内再確認で実用上塞いでいます
4. metrics / health check は未実装（リポに基盤なし）
5. 実機確認の副作用として dev DB に 15 件の IN_PROGRESS deliverable が残っています（消す場合は指示ください）

Next Steps
`

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
      fs.rmSync(scratchCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      cleanupFakeClaudeTranscripts()
    }
  })

  // The reported artifact itself, end to end: the exact text material it was reported against is pushed
  // through the real ConPTY *after* the pane's informational rows have appeared (the row-count changes that
  // used to corrupt it), and xterm.js's buffer must still hold it intact. Whitespace-insensitive, so
  // legitimate wrapping at whatever cols the window happens to give is not a failure -- what fails is the
  // artifact's shape: cells of one row surviving inside another.
  test('the reported text material survives a session with its informational rows showing', async () => {
    test.setTimeout(90_000)
    const launched = await launchApp()
    const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-cwd-'))
    const materialPath = path.join(scratchCwd, 'material.txt')
    fs.writeFileSync(materialPath, REPORTED_MATERIAL, 'utf-8')

    try {
      const { app, window: page } = launched
      await useFakeClaude(page)

      await app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = () =>
          Promise.resolve({ canceled: false, filePaths: [dir] } as Electron.OpenDialogReturnValue)
      }, scratchCwd)
      await page.locator('.pane-header button:has-text("フォルダ選択")').first().click()
      await expect(page.locator('.pane-cwd').first()).toHaveText(scratchCwd)

      const purposeText = `E2E素材-${Date.now()}`
      await page.locator('.pane-header button:has-text("＋ 新規セッション")').first().click()
      await page.locator('#purpose-dialog-text').fill(purposeText)
      await page.locator('.dialog-row__primary').click()
      await expect(page.locator('.pane-header button:has-text("停止")').first()).toBeVisible()
      await expect
        .poll(async () => await readPaneTerminalText(page, 0), {
          timeout: 20_000,
          message: 'TD-1 の目的プロンプト送信が完了するまで待機'
        })
        .toContain(`了解しました（フェイク応答）: ${purposeText}`)

      // All three informational rows plus the context gauge are on screen before the material is emitted,
      // so anything they do to the pane's height has already happened.
      await expect(page.locator('.pane-purpose').first()).toBeVisible()
      await expect(page.locator('.pane-repo-sync').first()).toBeVisible()
      await expect(page.locator('.pane-telemetry').first()).toBeVisible()

      await focusPaneTerminal(page, 0)
      await page.keyboard.type(`#emit ${materialPath}`)
      await page.keyboard.press('Enter')
      const lastLine = REPORTED_MATERIAL.trimEnd().split('\n').at(-1) as string
      await expect
        .poll(async () => await readPaneTerminalText(page, 0), {
          timeout: 20_000,
          message: '素材の最終行が端末バッファに現れるまで待機'
        })
        .toContain(lastLine)

      const squeeze = (s: string): string => s.replace(/\s+/g, '')
      expect(
        squeeze(await readPaneTerminalText(page, 0)),
        '素材が端末バッファの中で崩れている（行頭などのセルに別の行の文字が残っている）'
      ).toContain(squeeze(REPORTED_MATERIAL))
    } finally {
      await closeApp(launched)
      fs.rmSync(scratchCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      cleanupFakeClaudeTranscripts()
    }
  })

  // The scroll-driven half of the reported artifact, with no resize involved at all. ConPTY compacts a
  // "this row goes blank, the next row gains text at the same column" repaint into a bare LF used as an
  // *index* (move down one row, keep the column): `ESC[r;3H ESC[K <text> LF <text>`. Columns 0-1 are
  // deliberately never re-sent, because ConPTY knows they already hold what it wants. A terminal that
  // converts that LF into CRLF puts the second line at column 0 instead of column 2, so the text reads one
  // full-width character too far left and the cells ConPTY never re-sends survive at the row head -- the
  // reported "スクロールすると左端の文字が1文字分左にずれ、行頭に前の行の文字が残る". Measured against the
  // real claude CLI's own scrollback viewer driven by PageUp and by the mouse wheel: 36+ corrupted rows per
  // scroll session with xterm.js's `convertEol` on, none with it off, at every geometry tried.
  test('an indented in-place repaint never leaves anything in the row head', async () => {
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

      const purposeText = `E2E行頭-${Date.now()}`
      await page.locator('.pane-header button:has-text("＋ 新規セッション")').first().click()
      await page.locator('#purpose-dialog-text').fill(purposeText)
      await page.locator('.dialog-row__primary').click()
      await expect(page.locator('.pane-header button:has-text("停止")').first()).toBeVisible()
      await expect
        .poll(async () => await readPaneTerminalText(page, 0), {
          timeout: 20_000,
          message: 'TD-1 の目的プロンプト送信が完了するまで待機'
        })
        .toContain(`了解しました（フェイク応答）: ${purposeText}`)

      await focusPaneTerminal(page, 0)
      // One command, five self-driven repaints at alternating offsets, so every repaint blanks a row that
      // had text and fills the row below it -- the diff shape that makes ConPTY reach for the LF index.
      await page.keyboard.type('#frames')
      await page.keyboard.press('Enter')
      await expect
        .poll(async () => await readPaneTerminalText(page, 0), {
          timeout: 15_000,
          message: '最後のフレームが端末バッファに現れるまで待機'
        })
        .toContain('◆ F51 行目')

      // Every painted row starts at column 2, so any buffer line carrying the frame's marker that does not
      // begin with two spaces is either a row that landed a full-width character too far left, or a stale
      // cell of an earlier frame that survived in the row head.
      const offending = (await readPaneTerminalText(page, 0))
        .split('\n')
        .filter((line) => line.includes('◆') && !line.startsWith('  '))
      expect(
        offending,
        '再描画後の行頭（0〜1 列目）に文字が残っている、または行が1文字分左にずれている'
      ).toEqual([])
    } finally {
      await closeApp(launched)
      fs.rmSync(scratchCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      cleanupFakeClaudeTranscripts()
    }
  })

  // The root cause behind the reported artifact, stated as an invariant on the one thing cockpit itself
  // controls. ConPTY reprints its own view of the screen on every resize and still counts rows xterm.js has
  // moved into its scrollback as on-screen, so *any* change to a running pty's row count desynchronises the
  // two and leaves cells of unrelated rows behind. Measured against a real ConPTY driving a real xterm.js
  // buffer: with no resize the buffer stays identical to the emitted text over repeated runs, while the
  // 3-row change the pane's informational rows used to cause corrupts it on every run -- and swapping the
  // term.resize/pty.resize order does not help, because the disagreement is ConPTY's, not a race. The rows
  // therefore live in a constant-height band (.pane-info) instead of stealing height from the terminal.
  test("a session starting does not change its pane's terminal row count", async () => {
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

      const gridBefore = await readPaneTerminalGrid(page, 0)
      expect(gridBefore, 'ペインの端末が観測できていない').not.toBeNull()

      await page.locator('.pane-header button:has-text("＋ 新規セッション")').first().click()
      await page.locator('#purpose-dialog-text').fill(`E2E行数不変-${Date.now()}`)
      await page.locator('.dialog-row__primary').click()
      await expect(page.locator('.pane-header button:has-text("停止")').first()).toBeVisible()

      // The three rows that used to appear one after another, seconds apart, each shrinking the terminal:
      // the purpose text, the git-sync outcome for a non-repo cwd, and the session telemetry line.
      await expect(page.locator('.pane-purpose').first()).toBeVisible()
      await expect(page.locator('.pane-repo-sync').first()).toBeVisible()
      await expect(page.locator('.pane-telemetry').first()).toBeVisible()

      expect(
        await readPaneTerminalGrid(page, 0),
        'セッション開始でペインの情報行が現れた結果、端末の行数が変わっている（実行中の pty をリサイズすると ConPTY と xterm.js の行対応がずれ、行頭に前の行のセルが残る）'
      ).toEqual(gridBefore)
    } finally {
      await closeApp(launched)
      fs.rmSync(scratchCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      cleanupFakeClaudeTranscripts()
    }
  })
})
