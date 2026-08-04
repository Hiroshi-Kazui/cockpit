// M9 E2E suite (Playwright + Electron, ADR-0010): purpose-completion evaluation. Exercises the full
// user-facing flow against the same fake-claude fixture app.spec.ts/archive-output.spec.ts use --
// 完了 -> 評価行生成(ok) -> ダイアログ表示、出力先設定時のレポート生成、fake claude 失敗時のエラー可視化+再実行.
// See fake-claude.js's header comment for how it distinguishes a title-generation one-shot from an
// evaluation one-shot (both use the identical `-p --model <model>` shape) and how the
// `--model e2e-fail-model` sentinel deterministically fails an evaluation for the recovery test below.
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupFakeClaudeTranscripts,
  closeApp,
  launchApp,
  useFakeClaude,
  type LaunchedApp
} from './fixtures/electronApp'

const PANE_HEADER_FOLDER_BUTTON = 'button:has-text("フォルダ選択")'
const PANE_HEADER_NEW_SESSION_BUTTON = 'button:has-text("＋ 新規セッション")'

/** Same polling-click helper app.spec.ts's focusPaneTerminal uses -- a plain click can race xterm.js's
 * ResizeObserver-driven fit/reflow right after a layout switch. */
async function focusPaneTerminal(page: Page, index: number): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.locator('.pane-terminal').nth(index).click({ force: true })
        return page.evaluate(() => document.activeElement?.className ?? null)
      },
      { timeout: 5000, message: `expected pane ${index}'s xterm textarea to receive DOM focus` }
    )
    .toBe('xterm-helper-textarea')
}

async function startFakeSession(
  app: LaunchedApp['app'],
  page: LaunchedApp['window'],
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
}

test.describe('purpose-completion evaluation (M9, ADR-0010)', () => {
  test('completing a purpose runs the evaluation and shows an ok result in the dialog', async () => {
    test.setTimeout(90_000)
    let launched: LaunchedApp | undefined
    const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-eval-cwd-'))
    const purposeText = `E2E評価テスト-${Date.now()}`

    try {
      launched = await launchApp()
      const { app, window: page } = launched
      await useFakeClaude(page)

      await test.step('start a session', async () => {
        await startFakeSession(app, page, scratchCwd, purposeText)
        // Let at least one real exchange land in the transcript before completing (D-8: evaluation needs
        // genuine user text, or the purpose is 'skipped' rather than 'ok').
        await expect
          .poll(
            () =>
              page.evaluate(() =>
                window.cockpit.archive.listSessions({ searchText: '' }).then((rows) => rows.length)
              ),
            { timeout: 20_000 }
          )
          .toBeGreaterThan(0)
      })

      await test.step('completing the purpose auto-opens the evaluation dialog and reaches ok', async () => {
        await page.locator('.pane-header button:has-text("完了")').first().click()
        await expect(page.locator('.evaluation-dialog')).toBeVisible()

        await expect(page.locator('.evaluation-dialog__chart')).toBeVisible({ timeout: 30_000 })
        await expect(page.locator('.evaluation-dialog__raw-scores')).toContainText('82')
        await expect(page.locator('.evaluation-dialog__summary')).toContainText('E2Eフェイク評価')
        await expect(page.locator('.evaluation-dialog__suggestions')).toContainText('E2Eユーザー改善案')

        await page.keyboard.press('Escape')
        await expect(page.locator('.evaluation-dialog')).toHaveCount(0)

        // Reopening via "評価を見る" shows the same (already-finalized) result without re-running.
        await page.locator('.pane-header button:has-text("評価を見る")').first().click()
        await expect(page.locator('.evaluation-dialog__chart')).toBeVisible()
        await page.keyboard.press('Escape')
      })

      await test.step('the evaluation dashboard reflects the new ok evaluation in its overall summary', async () => {
        await page.click('button:has-text("評価ダッシュボード")')
        await expect(page.locator('.evaluation-dashboard')).toBeVisible()
        await expect(page.locator('.evaluation-dashboard__overall')).toContainText('1件', {
          timeout: 10_000
        })
        await page.keyboard.press('Escape')
      })
    } finally {
      if (launched) await closeApp(launched)
      fs.rmSync(scratchCwd, { recursive: true, force: true })
      cleanupFakeClaudeTranscripts()
    }
  })

  test('configuring an output root writes a Markdown+JSON report on evaluation completion', async () => {
    test.setTimeout(90_000)
    let launched: LaunchedApp | undefined
    const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-eval-report-cwd-'))
    const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-eval-report-dest-'))
    const purposeText = `E2E評価レポートテスト-${Date.now()}`

    try {
      launched = await launchApp()
      const { app, window: page } = launched
      await useFakeClaude(page)

      await test.step('configure the evaluation report output root via the settings UI', async () => {
        await page.click('button:has-text("評価設定")')
        await expect(page.locator('.evaluation-settings')).toBeVisible()
        await app.evaluate(({ dialog }, dir) => {
          dialog.showOpenDialog = () =>
            Promise.resolve({ canceled: false, filePaths: [dir] } as Electron.OpenDialogReturnValue)
        }, reportRoot)
        await page.click('.evaluation-settings button:has-text("フォルダを選択…")')
        await expect(page.locator('.evaluation-settings__current')).toContainText(reportRoot)
        await page.keyboard.press('Escape')
        await expect(page.locator('.evaluation-settings')).toHaveCount(0)
      })

      await test.step('start a session and complete it', async () => {
        await startFakeSession(app, page, scratchCwd, purposeText)
        await expect
          .poll(
            () =>
              page.evaluate(() =>
                window.cockpit.archive.listSessions({ searchText: '' }).then((rows) => rows.length)
              ),
            { timeout: 20_000 }
          )
          .toBeGreaterThan(0)
        await page.locator('.pane-header button:has-text("完了")').first().click()
        await expect(page.locator('.evaluation-dialog__chart')).toBeVisible({ timeout: 30_000 })
      })

      await test.step('the report files appear at the configured output root', async () => {
        await expect
          .poll(() => fs.readdirSync(reportRoot).filter((f) => f.endsWith('.md')).length, {
            timeout: 15_000,
            message: 'expected a .md evaluation report to be written'
          })
          .toBe(1)
        const files = fs.readdirSync(reportRoot)
        const mdFile = files.find((f) => f.endsWith('.md'))!
        const jsonFile = files.find((f) => f.endsWith('.json'))!
        expect(jsonFile).toBeDefined()

        const md = fs.readFileSync(path.join(reportRoot, mdFile), 'utf-8')
        expect(md).toContain('E2Eフェイク評価')
        const json = JSON.parse(fs.readFileSync(path.join(reportRoot, jsonFile), 'utf-8'))
        expect(json.smoothness).toBe(82)

        await expect(page.locator('.evaluation-dialog__hint')).toContainText('保存しました', {
          timeout: 10_000
        })
      })
    } finally {
      if (launched) await closeApp(launched)
      fs.rmSync(scratchCwd, { recursive: true, force: true })
      fs.rmSync(reportRoot, { recursive: true, force: true })
      cleanupFakeClaudeTranscripts()
    }
  })

  test('a failing evaluation shows an error and recovers on manual re-run', async () => {
    test.setTimeout(90_000)
    let launched: LaunchedApp | undefined
    const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-eval-fail-cwd-'))
    const purposeText = `E2E評価失敗テスト-${Date.now()}`

    try {
      launched = await launchApp()
      const { app, window: page } = launched
      await useFakeClaude(page)

      await test.step('force the evaluation model to the E2E fixture failure sentinel', async () => {
        await page.click('button:has-text("評価設定")')
        await expect(page.locator('.evaluation-settings')).toBeVisible()
        await page.locator('#evaluation-model-input').fill('e2e-fail-model')
        await page.locator('#evaluation-model-input').blur()
        // The blur handler's IPC persist call is fire-and-forget from Playwright's perspective (blur()
        // only waits for the DOM event, not the async work it triggers) -- poll app_settings directly so
        // later steps never race ahead of the actual persisted value.
        await expect
          .poll(() => page.evaluate(() => window.cockpit.appSettings.get().then((s) => s.evaluationModel)))
          .toBe('e2e-fail-model')
        await page.keyboard.press('Escape')
        await expect(page.locator('.evaluation-settings')).toHaveCount(0)
      })

      await test.step('start a session and complete it -> evaluation fails visibly', async () => {
        await startFakeSession(app, page, scratchCwd, purposeText)
        await expect
          .poll(
            () =>
              page.evaluate(() =>
                window.cockpit.archive.listSessions({ searchText: '' }).then((rows) => rows.length)
              ),
            { timeout: 20_000 }
          )
          .toBeGreaterThan(0)
        await page.locator('.pane-header button:has-text("完了")').first().click()
        await expect(page.locator('.evaluation-dialog__error')).toBeVisible({ timeout: 30_000 })
      })

      await test.step('fixing the model and re-running recovers to an ok result', async () => {
        // Fix the model (back to the real default) while the evaluation dialog is still open, then re-run.
        await page.click('button:has-text("評価設定")')
        await page.locator('#evaluation-model-input').fill('haiku')
        await page.locator('#evaluation-model-input').blur()
        await expect
          .poll(() => page.evaluate(() => window.cockpit.appSettings.get().then((s) => s.evaluationModel)))
          .toBe('haiku')
        await page.keyboard.press('Escape')
        await expect(page.locator('.evaluation-settings')).toHaveCount(0)

        await page.locator('.evaluation-dialog__actions button:has-text("再評価する")').click()
        await expect(page.locator('.evaluation-dialog__chart')).toBeVisible({ timeout: 30_000 })
      })
    } finally {
      if (launched) await closeApp(launched)
      fs.rmSync(scratchCwd, { recursive: true, force: true })
      cleanupFakeClaudeTranscripts()
    }
  })

  // M9 FIX (iter1 blocking): completing a purpose while `evaluation_enabled` is off must behave exactly as
  // it did pre-M9 (no dialog ever auto-opens, since evaluationCoordinator.run() never creates a row for it)
  // -- and the manual "評価を見る" entry point must show an explicit "無効" state rather than an eternal
  // "読み込み中…" spinner for a purpose that was never evaluated.
  test('disabling evaluation: completing a purpose does not auto-open the dialog, and manual open shows an explicit disabled state', async () => {
    test.setTimeout(60_000)
    let launched: LaunchedApp | undefined
    const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-eval-disabled-cwd-'))
    const purposeText = `E2E評価無効テスト-${Date.now()}`

    try {
      launched = await launchApp()
      const { app, window: page } = launched
      await useFakeClaude(page)

      await test.step('turn evaluation off via 評価設定', async () => {
        await page.click('button:has-text("評価設定")')
        await expect(page.locator('.evaluation-settings')).toBeVisible()
        await page.locator('.evaluation-settings input[type="checkbox"]').uncheck()
        await expect
          .poll(() => page.evaluate(() => window.cockpit.appSettings.get().then((s) => s.evaluationEnabled)))
          .toBe(false)
        await page.keyboard.press('Escape')
        await expect(page.locator('.evaluation-settings')).toHaveCount(0)
      })

      await test.step('completing the purpose finishes normally, without the evaluation dialog appearing', async () => {
        await startFakeSession(app, page, scratchCwd, purposeText)
        await expect
          .poll(
            () =>
              page.evaluate(() =>
                window.cockpit.archive.listSessions({ searchText: '' }).then((rows) => rows.length)
              ),
            { timeout: 20_000 }
          )
          .toBeGreaterThan(0)

        await page.locator('.pane-header button:has-text("完了")').first().click()
        // M8-era behavior preserved: completion succeeds (badge appears) with no evaluation dialog ever
        // mounting -- give the fire-and-forget trigger a beat to (not) do anything before asserting absence.
        await expect(page.locator('.pane-title__badge')).toBeVisible()
        await page.waitForTimeout(1000)
        await expect(page.locator('.evaluation-dialog')).toHaveCount(0)
      })

      await test.step('manually opening "評価を見る" shows an explicit disabled state, not an infinite spinner', async () => {
        await page.locator('.pane-header button:has-text("評価を見る")').first().click()
        await expect(page.locator('.evaluation-dialog')).toBeVisible()
        await expect(page.locator('.evaluation-dialog__status')).toContainText('無効', { timeout: 10_000 })
        await page.keyboard.press('Escape')
      })
    } finally {
      if (launched) await closeApp(launched)
      fs.rmSync(scratchCwd, { recursive: true, force: true })
      cleanupFakeClaudeTranscripts()
    }
  })

  // M9 FIX (iter1 major): a pane-local EvaluationDialog is exactly as modal as SessionBrowser/
  // ArchiveOutputSettings/EvaluationDashboard/EvaluationSettings -- Ctrl+1..4 must not be able to jump
  // keyboard focus to another pane's live pty while it is open.
  test('while a pane evaluation dialog is open, Ctrl+1..4 does not move focus to another pane', async () => {
    test.setTimeout(90_000)
    let launched: LaunchedApp | undefined
    const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-eval-shortcut-cwd-'))
    const purposeText = `E2Eショートカット遮断テスト-${Date.now()}`

    try {
      launched = await launchApp()
      const { app, window: page } = launched
      await useFakeClaude(page)

      await page.click('.layout-switcher__button:has-text("4分割")')

      await test.step('start and complete a session in pane 0, opening the evaluation dialog', async () => {
        await startFakeSession(app, page, scratchCwd, purposeText)
        await expect
          .poll(
            () =>
              page.evaluate(() =>
                window.cockpit.archive.listSessions({ searchText: '' }).then((rows) => rows.length)
              ),
            { timeout: 20_000 }
          )
          .toBeGreaterThan(0)
        await page.locator('.pane-header button:has-text("完了")').first().click()
        await expect(page.locator('.evaluation-dialog')).toBeVisible()
      })

      await test.step('Ctrl+2 does not steal focus onto pane 1\'s terminal while the dialog is open', async () => {
        // The dialog itself should hold focus (its close button gets `autoFocus`, EvaluationDialog.tsx) --
        // assert the dialog's own focus trap: DOM focus stays inside `.evaluation-dialog`, never landing on
        // any xterm textarea in another pane, after the shortcut fires.
        await page.keyboard.press('Control+2')
        await expect(page.locator('.evaluation-dialog')).toBeVisible()
        const activeElementInsideDialog = await page.evaluate(
          () => document.activeElement?.closest('.evaluation-dialog') !== null
        )
        expect(activeElementInsideDialog).toBe(true)

        // Sanity check the shortcut is genuinely live again once the dialog closes (proves the assertion
        // above was actually exercising the guard, not just an unrelated always-true condition).
        await page.keyboard.press('Escape')
        await expect(page.locator('.evaluation-dialog')).toHaveCount(0)
        await focusPaneTerminal(page, 0)
        await page.keyboard.press('Control+2')
        const activePaneIndex = await page.evaluate(() => {
          const el = document.activeElement
          const slot = el?.closest('.pane-slot') ?? null
          if (!slot) return null
          return Array.from(document.querySelectorAll('.pane-slot')).indexOf(slot)
        })
        expect(activePaneIndex).toBe(1)
      })
    } finally {
      if (launched) await closeApp(launched)
      fs.rmSync(scratchCwd, { recursive: true, force: true })
      cleanupFakeClaudeTranscripts()
    }
  })
})
