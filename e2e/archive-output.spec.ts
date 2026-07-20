// M6 E2E suite (Playwright + Electron, spec §4.4.1, ADR-0008): archive output-destination mirroring.
// Exercises the full user-facing flow against the same fake-claude fixture app.spec.ts uses (see that
// file's header comment for why a fake CLI is used rather than a real claude account) --
// 出力先設定 -> セッション実行 -> ミラー生成 (transcript.jsonl + metadata.json appear at the destination and
// match the spool), then 出力先切断 (destination made unwritable) -> エラー表示 -> スプール無傷 (the claude
// dialogue keeps working, the app-managed spool copy keeps growing) -> 復旧で追い付き (once the destination
// is restored, the mirror catches up on its own).
import { expect, test } from '@playwright/test'
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

async function focusPaneTerminal(
  page: import('@playwright/test').Page,
  index: number
): Promise<void> {
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

test.describe('archive output-destination mirroring (M6, spec §4.4.1)', () => {
  test('output root configured -> session mirrored -> destination lost -> error shown, spool intact -> recovers', async () => {
    test.setTimeout(120_000)
    let launched: LaunchedApp | undefined
    const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-mirror-cwd-'))
    const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-mirror-dest-'))
    const purposeText = `E2Eミラーテスト-${Date.now()}`
    // ADR-0009 A -> B -> A switching-flow step (below) creates this lazily; declared here (not inside the
    // try block) so the finally block can clean it up regardless of where an early failure occurs.
    let mirrorRootB = ''

    try {
      launched = await launchApp()
      const { app, window: page } = launched
      await useFakeClaude(page)

      await test.step('configure the archive output root via the settings UI', async () => {
        await page.click('button:has-text("アーカイブ出力先")')
        await expect(page.locator('.archive-output-settings')).toBeVisible()

        await app.evaluate(({ dialog }, dir) => {
          dialog.showOpenDialog = () =>
            Promise.resolve({ canceled: false, filePaths: [dir] } as Electron.OpenDialogReturnValue)
        }, mirrorRoot)
        await page.click('button:has-text("フォルダを選択…")')
        await expect(page.locator('.archive-output-settings__current-value')).toHaveText(mirrorRoot)

        await page.keyboard.press('Escape')
        await expect(page.locator('.archive-output-settings')).toHaveCount(0)
      })

      await test.step('start a session (folder select + purpose dialog, same flow as app.spec.ts)', async () => {
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
      })

      let sessionId = ''
      await test.step('mirror produces transcript.jsonl + metadata.json matching the spool', async () => {
        await expect
          .poll(() => fs.readdirSync(mirrorRoot).length, {
            timeout: 20_000,
            message: 'expected a session directory to appear under the configured output root'
          })
          .toBeGreaterThan(0)
        sessionId = fs.readdirSync(mirrorRoot)[0]

        await expect
          .poll(() => fs.existsSync(path.join(mirrorRoot, sessionId, 'transcript.jsonl')), {
            timeout: 10_000
          })
          .toBe(true)
        await expect
          .poll(() => fs.existsSync(path.join(mirrorRoot, sessionId, 'metadata.json')), {
            timeout: 10_000
          })
          .toBe(true)

        const mirroredTranscript = fs.readFileSync(
          path.join(mirrorRoot, sessionId, 'transcript.jsonl'),
          'utf-8'
        )
        expect(mirroredTranscript).toContain(purposeText)

        const spoolTranscript = fs.readFileSync(
          path.join(launched!.userDataDir, 'archive', sessionId, 'transcript.jsonl'),
          'utf-8'
        )
        expect(mirroredTranscript).toBe(spoolTranscript)
      })

      await test.step('destination becomes unreachable (folder replaced by a blocking file) -> error is shown, but claude keeps working and the spool keeps growing', async () => {
        fs.rmSync(mirrorRoot, { recursive: true, force: true })
        fs.writeFileSync(
          mirrorRoot,
          'this file blocks the mirror destination from being a directory'
        )

        // Drive new archiver/mirror activity by sending another message through the real xterm.js terminal.
        await focusPaneTerminal(page, 0)
        await page.keyboard.type('message while the mirror destination is broken')
        await page.keyboard.press('Enter')
        // The claude dialogue itself is completely unaffected by the mirror failure (D-2/D-5).
        await expect(page.locator('.pane-terminal').nth(0)).toContainText('了解しました', {
          timeout: 10_000
        })

        await expect(page.locator('.status-bar__mirror--error')).toBeVisible({ timeout: 20_000 })

        // Spool (record of truth) is untouched by the destination failure -- it keeps growing with the
        // new message, independent of whether the mirror could relay it anywhere.
        await expect
          .poll(
            () =>
              fs
                .readFileSync(
                  path.join(launched!.userDataDir, 'archive', sessionId, 'transcript.jsonl'),
                  'utf-8'
                )
                .includes('message while the mirror destination is broken'),
            { timeout: 10_000 }
          )
          .toBe(true)
      })

      await test.step('destination restored -> the mirror catches up on its own (fire-and-forget retry)', async () => {
        fs.rmSync(mirrorRoot, { force: true })
        fs.mkdirSync(mirrorRoot, { recursive: true })

        await expect
          .poll(
            () => {
              const file = path.join(mirrorRoot, sessionId, 'transcript.jsonl')
              return fs.existsSync(file) && fs.readFileSync(file, 'utf-8')
            },
            {
              timeout: 30_000,
              message: 'expected the mirror to recover and catch up automatically'
            }
          )
          .toContain('message while the mirror destination is broken')

        await expect(page.locator('.status-bar__mirror--synced')).toBeVisible({ timeout: 20_000 })
      })

      // ADR-0009 / plan.md Phase 4 "E2E は切替フローで確認": unit tests (mirrorCoordinator.test.ts) fully
      // exercise the A -> B -> A byte-level resume; this step confirms the actual UI-driven switching flow
      // (フォルダを選択… twice) works end-to-end without ever surfacing an error, and that mirroring keeps
      // working (not just "doesn't crash") once switched back.
      await test.step('switching the output root away and back (A -> B -> A) resumes automatically via the UI, without erroring', async () => {
        mirrorRootB = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-mirror-destB-'))

        await page.click('button:has-text("アーカイブ出力先")')
        await expect(page.locator('.archive-output-settings')).toBeVisible()
        await app.evaluate(({ dialog }, dir) => {
          dialog.showOpenDialog = () =>
            Promise.resolve({ canceled: false, filePaths: [dir] } as Electron.OpenDialogReturnValue)
        }, mirrorRootB)
        await page.click('button:has-text("フォルダを選択…")')
        await expect(page.locator('.archive-output-settings__current-value')).toHaveText(
          mirrorRootB
        )
        await page.keyboard.press('Escape')
        await expect(page.locator('.archive-output-settings')).toHaveCount(0)

        await focusPaneTerminal(page, 0)
        await page.keyboard.type('message while output root is B')
        await page.keyboard.press('Enter')
        await expect(page.locator('.pane-terminal').nth(0)).toContainText('了解しました', {
          timeout: 10_000
        })
        await expect
          .poll(() => fs.existsSync(path.join(mirrorRootB, sessionId, 'transcript.jsonl')), {
            timeout: 20_000
          })
          .toBe(true)

        // Switch back to A.
        await page.click('button:has-text("アーカイブ出力先")')
        await expect(page.locator('.archive-output-settings')).toBeVisible()
        await app.evaluate(({ dialog }, dir) => {
          dialog.showOpenDialog = () =>
            Promise.resolve({ canceled: false, filePaths: [dir] } as Electron.OpenDialogReturnValue)
        }, mirrorRoot)
        await page.click('button:has-text("フォルダを選択…")')
        await expect(page.locator('.archive-output-settings__current-value')).toHaveText(mirrorRoot)
        await page.keyboard.press('Escape')
        await expect(page.locator('.archive-output-settings')).toHaveCount(0)

        // ADR-0009: A's own per-root progress resumes automatically -- no permanent error (the M6
        // single-row schema's safe-stop this milestone supersedes).
        await expect(page.locator('.status-bar__mirror--synced')).toBeVisible({ timeout: 20_000 })
        await expect(page.locator('.status-bar__mirror--error')).toHaveCount(0)

        // Further growth mirrors correctly to A once resumed (proves an actual working resume, not just
        // the absence of an error badge).
        await focusPaneTerminal(page, 0)
        await page.keyboard.type('message after switching back to A')
        await page.keyboard.press('Enter')
        await expect(page.locator('.pane-terminal').nth(0)).toContainText('了解しました', {
          timeout: 10_000
        })
        await expect
          .poll(
            () =>
              fs
                .readFileSync(path.join(mirrorRoot, sessionId, 'transcript.jsonl'), 'utf-8')
                .includes('message after switching back to A'),
            { timeout: 20_000 }
          )
          .toBe(true)
      })
    } finally {
      if (launched) await closeApp(launched)
      fs.rmSync(scratchCwd, { recursive: true, force: true })
      fs.rmSync(mirrorRoot, { recursive: true, force: true })
      if (mirrorRootB) fs.rmSync(mirrorRootB, { recursive: true, force: true })
      cleanupFakeClaudeTranscripts()
    }
  })
})

// M7 followup (UX: フォーカス復帰先の不一致) -- opening the archive-output settings dialog from either the
// header button or StatusBar's mirror indicator must restore focus to whichever one actually opened it.
// No fake-claude/session needed: only requires an output root configured (so the StatusBar indicator
// renders at all) and the header button, both reachable from the plain app shell.
test.describe('archive output settings dialog: opener-based focus restore (M7 followup)', () => {
  test('closing (Escape) restores focus to the header button or the status bar indicator, matching whichever opened it', async () => {
    let launched: LaunchedApp | undefined
    const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-focus-mirror-'))

    try {
      launched = await launchApp()
      const { app, window: page } = launched

      // Configure an output root so StatusBar's mirror indicator renders at all.
      const headerButton = page.locator('.app-header__archive-button:has-text("アーカイブ出力先")')
      await headerButton.click()
      await expect(page.locator('.archive-output-settings')).toBeVisible()
      await app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = () =>
          Promise.resolve({ canceled: false, filePaths: [dir] } as Electron.OpenDialogReturnValue)
      }, mirrorRoot)
      await page.click('button:has-text("フォルダを選択…")')
      await expect(page.locator('.archive-output-settings__current-value')).toHaveText(mirrorRoot)
      await page.keyboard.press('Escape')
      await expect(page.locator('.archive-output-settings')).toHaveCount(0)

      // 1) Opened via the header button -> closing returns focus there.
      await headerButton.click()
      await expect(page.locator('.archive-output-settings')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.locator('.archive-output-settings')).toHaveCount(0)
      await expect(headerButton).toBeFocused()

      // 2) Opened via the StatusBar mirror indicator -> closing returns focus there instead, not the
      // header button.
      const mirrorIndicator = page.locator('.status-bar__mirror')
      await expect(mirrorIndicator).toBeVisible({ timeout: 20_000 })
      await mirrorIndicator.click()
      await expect(page.locator('.archive-output-settings')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.locator('.archive-output-settings')).toHaveCount(0)
      await expect(mirrorIndicator).toBeFocused()
    } finally {
      if (launched) await closeApp(launched)
      fs.rmSync(mirrorRoot, { recursive: true, force: true })
    }
  })
})
