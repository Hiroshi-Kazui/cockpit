// M14 E2E suite (Playwright + Electron, ADR-0016): the two user-facing behaviors this milestone adds.
//   1. 完了済みの目的で「停止」を押すとペインが片付く（端末の内容・情報行が消え、exit 通知も残らない）。
//      進行中（再開待ち）の目的では何も消えない。
//   2. 評価に異議を申し立てて再評価を求めると、その異議文が headless プロンプトへ届き、新しい評価行に
//      記録される（fake-claude が異議つきプロンプトにだけ別の総評を返すので、届いたことが観測できる）。
// 実行環境は evaluation.spec.ts と同じ fake-claude 一式。
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupFakeClaudeTranscripts,
  closeApp,
  focusPaneTerminal,
  launchApp,
  readPaneTerminalText,
  runElectronAsNode,
  useFakeClaude,
  type LaunchedApp
} from './fixtures/electronApp'

const SEED_SCRIPT = path.join(__dirname, 'fixtures', 'seed-purpose-with-evaluation.js')
const READ_SCRIPT = path.join(__dirname, 'fixtures', 'read-evaluations.js')

interface SeededEvaluationRow {
  id: string
  status: string
  summary: string | null
  appeal_text: string | null
}

function readEvaluations(userDataDir: string, purposeId: string): SeededEvaluationRow[] {
  return JSON.parse(runElectronAsNode(READ_SCRIPT, [userDataDir, purposeId])) as SeededEvaluationRow[]
}

const PANE_HEADER_FOLDER_BUTTON = 'button:has-text("フォルダ選択")'
const PANE_HEADER_NEW_SESSION_BUTTON = 'button:has-text("＋ 新規セッション")'

async function startFakeSession(
  app: LaunchedApp['app'],
  page: Page,
  cwd: string,
  purposeText: string
): Promise<void> {
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [dir] } as Electron.OpenDialogReturnValue)
  }, cwd)
  await page.locator(PANE_HEADER_FOLDER_BUTTON).first().click()
  await expect(page.locator('.pane-cwd').first()).toHaveText(cwd)

  await page.locator(PANE_HEADER_NEW_SESSION_BUTTON).first().click()
  await page.locator('#purpose-dialog-text').fill(purposeText)
  await page.locator('.dialog-row__primary').click()
  await expect(page.locator('.pane-header button:has-text("停止")').first()).toBeVisible()

  // Wait for real pty output to land in the terminal -- the cleanup assertions below are only meaningful
  // once there is something on screen to clean up.
  await expect
    .poll(() => readPaneTerminalText(page, 0).then((text) => text.trim().length), {
      timeout: 20_000,
      message: 'expected the fake claude session to print something into pane 0'
    })
    .toBeGreaterThan(0)

}

/** The evaluation only has something to judge once a genuine user *turn* has actually been archived
 * (ADR-0010 D-8: a purpose with no user text is confirmed 'skipped' without ever calling the LLM). Waiting
 * for the session row alone is not enough -- the row appears as soon as the session is linked, seconds
 * before the initial prompt's turn reaches the spool transcript, which is exactly the race that makes a
 * completion at that moment produce a 'skipped' evaluation. Measured on this repo: with only the row-level
 * wait the evaluation comes back with userMessageCount 0; waiting for a turn makes it 'ok'. */
async function waitForArchivedUserTurn(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const sessions = await window.cockpit.archive.listSessions({ searchText: '' })
          if (sessions.length === 0) return 0
          const read = await window.cockpit.archive.readSession({ sessionId: sessions[0].id })
          if (!read.ok) return 0
          return read.turns.filter((turn) => turn.role === 'user').length
        }),
      {
        timeout: 30_000,
        message: 'expected an archived user turn before completing the purpose'
      }
    )
    .toBeGreaterThan(0)
}

test.describe('M14: stop cleanup and evaluation appeal', () => {
  test('stopping a completed purpose empties the pane; stopping an active one does not', async () => {
    test.setTimeout(120_000)
    let launched: LaunchedApp | undefined
    const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-m14-cleanup-'))
    const purposeText = `E2E停止クリーンナップ-${Date.now()}`

    try {
      launched = await launchApp()
      const { app, window: page } = launched
      await useFakeClaude(page)
      await startFakeSession(app, page, scratchCwd, purposeText)

      await test.step('R-2: stopping while the purpose is still active keeps the terminal contents', async () => {
        await page.locator('.pane-header button:has-text("停止")').first().click()
        await expect(page.locator('.pane-resume-overlay').first()).toBeVisible()
        expect((await readPaneTerminalText(page, 0)).trim().length).toBeGreaterThan(0)
      })

      await test.step('resume, complete the purpose, then stop -- the pane is emptied', async () => {
        await page.locator('.pane-resume-overlay__button').first().click()
        await expect(page.locator('.pane-header button:has-text("停止")').first()).toBeVisible()

        await page.locator('.pane-header button:has-text("完了")').first().click()
        // The evaluation dialog auto-opens on completion; dismiss it, this test is about the pane.
        await expect(page.locator('.evaluation-dialog')).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(page.locator('.evaluation-dialog')).toHaveCount(0)

        // R-3: make the pane produce output right up to the moment it is killed. ConPTY keeps handing
        // node-pty what it had already buffered after the child is gone, so this guarantees late
        // `pty:data` events arrive *after* the cleanup -- the real claude CLI hits this on every stop,
        // while a quiet fake resolves the race by luck and hides the defect.
        await focusPaneTerminal(page, 0)
        await page.keyboard.type('#spew')
        await page.keyboard.press('Enter')
        await expect
          .poll(() => readPaneTerminalText(page, 0).then((text) => text.includes('SPEW')), {
            timeout: 10_000,
            message: 'expected the fake claude session to be flooding pane 0 before the stop'
          })
          .toBe(true)

        await page.locator('.pane-header button:has-text("停止")').first().click()

        // R-1/R-3: empty, and it stays empty -- the exit notice and any late pty output must not land
        // afterwards (pty.kill's resolution and the exit event race each other).
        await expect
          .poll(() => readPaneTerminalText(page, 0).then((text) => text.trim()), {
            timeout: 15_000,
            message: 'expected pane 0 to be emptied after stopping a completed purpose'
          })
          .toBe('')
        await expect(page.locator('.pane-telemetry')).toHaveCount(0)
        await expect(page.locator('.pane-info .pane-error')).toHaveCount(0)
        await expect
          .poll(() => readPaneTerminalText(page, 0).then((text) => text.includes('claude exited')), {
            timeout: 5_000
          })
          .toBe(false)

        // R-1: the completed purpose stays reachable -- only the session's leftovers were cleared.
        await expect(page.locator('.pane-title__badge').first()).toHaveText('完了済み')
        await expect(page.locator('.pane-header button:has-text("評価を見る")').first()).toBeVisible()
      })
    } finally {
      if (launched) await closeApp(launched)
      fs.rmSync(scratchCwd, { recursive: true, force: true })
      cleanupFakeClaudeTranscripts()
    }
  })

  // The test above needs a real archived transcript (the whole M9 pipeline). This one covers the same
  // appeal wiring -- dialog -> IPC -> coordinator -> DB -- against a *seeded* database instead, so the
  // renderer/main round-trip and ADR-0016 D-4's real ALTER TABLE migration are verified even where the
  // transcript-archiving fixtures are unavailable. The re-evaluation it triggers has no linked session, so
  // it is confirmed 'skipped' (D-8) -- what matters here is that the appeal was carried and persisted.
  test('appealing from the dialog records the appeal on a brand-new evaluation row', async () => {
    test.setTimeout(120_000)
    let launched: LaunchedApp | undefined
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-m14-appeal-db-'))
    const purposeId = `m14-purpose-${Date.now()}`
    const appealText = 'ストレス度80は体感より高い。手戻りは一度も無かった。'

    try {
      runElectronAsNode(SEED_SCRIPT, [userDataDir, purposeId])
      launched = await launchApp(userDataDir)
      const page = launched.window

      await test.step('ADR-0016 D-4: startup migration adds appeal_text to the pre-M14 table', async () => {
        const rows = readEvaluations(userDataDir, purposeId)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ id: 'm14-seed-eval', status: 'ok', appeal_text: null })
      })

      await test.step('complete the seeded purpose and turn evaluation back on', async () => {
        await page.locator('.pane-header button:has-text("完了")').first().click()
        await expect(page.locator('.pane-title__badge').first()).toHaveText('完了済み')

        await page.click('button:has-text("評価設定")')
        await expect(page.locator('.evaluation-settings')).toBeVisible()
        await page.locator('.evaluation-settings input[type="checkbox"]').check()
        await expect
          .poll(() => page.evaluate(() => window.cockpit.appSettings.get().then((s) => s.evaluationEnabled)))
          .toBe(true)
        await page.keyboard.press('Escape')
        await expect(page.locator('.evaluation-settings')).toHaveCount(0)
      })

      await test.step('R-5: the appeal box rejects an empty appeal and accepts a real one', async () => {
        await page.locator('.pane-header button:has-text("評価を見る")').first().click()
        await expect(page.locator('.evaluation-dialog__chart')).toBeVisible()
        await expect(page.locator('button:has-text("異議を申し立てて再評価")')).toBeDisabled()

        await page.locator('#evaluation-appeal-text').fill(appealText)
        await expect(page.locator('button:has-text("異議を申し立てて再評価")')).toBeEnabled()
        await page.locator('button:has-text("異議を申し立てて再評価")').click()
      })

      await test.step('R-7: a brand-new row carries the appeal; the disputed row is untouched', async () => {
        await expect
          .poll(() => readEvaluations(userDataDir, purposeId).length, {
            timeout: 20_000,
            message: 'expected the appeal to create a new evaluation row'
          })
          .toBe(2)
        const rows = readEvaluations(userDataDir, purposeId)
        expect(rows[0].appeal_text).toBe(appealText)
        expect(rows[0].id).not.toBe('m14-seed-eval')
        expect(rows[1]).toMatchObject({
          id: 'm14-seed-eval',
          status: 'ok',
          summary: '苦戦していました',
          appeal_text: null
        })
      })
    } finally {
      if (launched) await closeApp(launched)
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  test('an appeal reaches the evaluation prompt and is recorded on the new evaluation', async () => {
    test.setTimeout(120_000)
    let launched: LaunchedApp | undefined
    const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-m14-appeal-'))
    const purposeText = `E2E異議申し立て-${Date.now()}`
    const appealText = 'ストレス度15は体感より高い。手戻りは一度も無かった。'

    try {
      launched = await launchApp()
      const { app, window: page } = launched
      await useFakeClaude(page)
      await startFakeSession(app, page, scratchCwd, purposeText)
      await waitForArchivedUserTurn(page)

      await test.step('complete the purpose and get the first evaluation', async () => {
        await page.locator('.pane-header button:has-text("完了")').first().click()
        await expect(page.locator('.evaluation-dialog__chart')).toBeVisible({ timeout: 30_000 })
        await expect(page.locator('.evaluation-dialog__summary')).toContainText('E2Eフェイク評価')
      })

      await test.step('R-5/R-6: appeal, and the re-evaluation answers the appealed prompt', async () => {
        await page.locator('#evaluation-appeal-text').fill(appealText)
        await page.locator('button:has-text("異議を申し立てて再評価")').click()

        await expect(page.locator('.evaluation-dialog__summary')).toContainText(
          'E2Eフェイク再評価: 異議を踏まえて見直しました',
          { timeout: 30_000 }
        )
        // R-7: the appeal is recorded on (and displayed for) the new evaluation row.
        await expect(page.locator('.evaluation-dialog__appeal-note')).toContainText(appealText)
        await expect(page.locator('.evaluation-dialog__appeal-text')).toHaveValue('')
      })

      await test.step('R-5: an empty appeal cannot be submitted', async () => {
        await expect(page.locator('button:has-text("異議を申し立てて再評価")')).toBeDisabled()
        await page.locator('#evaluation-appeal-text').fill('   ')
        await expect(page.locator('button:has-text("異議を申し立てて再評価")')).toBeDisabled()
      })
    } finally {
      if (launched) await closeApp(launched)
      fs.rmSync(scratchCwd, { recursive: true, force: true })
      cleanupFakeClaudeTranscripts()
    }
  })
})
