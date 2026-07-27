// Shared Electron-launch boilerplate for the M5 E2E suite. Every test gets its own fully-isolated
// --user-data-dir (own cockpit.db, own archive/, own generated statusline settings) so tests never touch
// a developer's real cockpit profile and never interfere with each other.
//
// IMPORTANT (discovered empirically while building this suite): launching with
// `_electron.launch({ args: ['out/main/index.js'] })` makes Electron treat `out/main` itself as the "app
// directory" (no upward package.json search happens when a *file* path is passed as the sole positional
// arg) -- `app.getAppPath()` then resolves to `out/main`, not the repo root, which breaks
// resolveForwarderScriptPath()'s dev-mode `path.join(app.getAppPath(), 'resources', ...)` lookup (TD-4)
// silently (statusLine chaining would then just never fire). Launching with `args: ['.']` and
// `cwd: repoRoot` instead makes Electron resolve the app the same way `npm run dev` / a real user
// double-clicking the packaged app would -- verified via `app.getAppPath()` returning the repo root, and
// `resources/statusline-forwarder.js` existing under it, in exactly this configuration.
import {
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PaneIndex } from '@shared/ipc'

// `window.__cockpitTestHooks`'s type (used by `readPaneTerminalText` below) comes from
// src/shared/testHooks.ts's `declare global` augmentation -- the single canonical definition of this
// renderer/e2e boundary contract. `tsconfig.e2e.json` includes `src/shared/**/*.ts`, so that ambient
// declaration is already part of this program without needing an explicit import here (an explicit
// side-effect import would additionally require Playwright's runtime loader to resolve the `@shared/*`
// path alias, which is not configured for it).

export const REPO_ROOT = path.resolve(__dirname, '..', '..')

export interface LaunchedApp {
  app: ElectronApplication
  window: Page
  userDataDir: string
}

/** Launches the built app (`npm run build` must have run first -- see package.json's `test:e2e` script)
 * with a fresh, isolated --user-data-dir. */
export async function launchApp(): Promise<LaunchedApp> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-userdata-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT
  })
  const window = await app.firstWindow()
  await window.waitForSelector('.app-header h1')
  return { app, window, userDataDir }
}

/** Removes `targetPath` recursively, retrying on transient Windows EPERM/EBUSY. Observed empirically: a
 * just-killed pty child process (e.g. fake-claude's `node.exe`, killed via `before-quit`'s
 * `ptyManager.killAll()` when `app.close()` above resolves) can still hold a directory as its cwd for a
 * short window after the OS call that killed it returns -- Windows only releases that lock once the
 * process is actually reaped, which can lag by up to a couple hundred ms. Re-throws once `timeoutMs` has
 * elapsed so a genuine (non-transient) failure still surfaces rather than being silently swallowed. */
export async function rmDirWithRetry(targetPath: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true })
      return
    } catch (err) {
      if (Date.now() - start >= timeoutMs) throw err
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

/** Closes the app and removes its isolated userData dir (retrying past the transient Windows directory-lock
 * race described on `rmDirWithRetry`). */
export async function closeApp(launched: LaunchedApp): Promise<void> {
  await launched.app.close().catch(() => {
    // Best-effort -- if the app already crashed/closed, there's nothing more to do.
  })
  await rmDirWithRetry(launched.userDataDir)
}

/** Points app_settings.claude_path at the E2E fake-claude fixture (see e2e/fixtures/fake-claude.js) via
 * the app's own real preload-exposed IPC API (window.cockpit.appSettings.setClaudePath) -- exercising the
 * actual production IPC contract rather than reaching around it.
 *
 * NOTE: the callback param below is intentionally named `page` (not `window`) -- `page.evaluate` runs the
 * callback source inside the *browser's* global scope, where the real DOM `window` (with our app's
 * preload-exposed `window.cockpit`) already exists; naming this parameter `window` would instead shadow
 * that ambient global with our Node-side `Page` object at the TypeScript level. */
export async function useFakeClaude(page: Page): Promise<void> {
  const fakeClaudePath = path.join(__dirname, 'fake-claude.cmd')
  await page.evaluate(
    (claudePath) => window.cockpit.appSettings.setClaudePath({ claudePath }),
    fakeClaudePath
  )
}

/** Reads the actual rendered content of pane `pane`'s xterm.js terminal, via the renderer-side
 * `window.__cockpitTestHooks.readPaneText` observation point (src/renderer/src/testing/terminalProbe.ts,
 * contract type shared/testHooks.ts). Only a plain string crosses this boundary -- no xterm.js
 * Terminal/Buffer shape is (re-)declared here. Returns `''` if the pane's terminal hasn't mounted yet, or
 * the hook itself hasn't loaded yet (defensive; every caller pairs this with `expect.poll`, which retries
 * until the awaited text actually appears). */
export async function readPaneTerminalText(page: Page, pane: PaneIndex): Promise<string> {
  return page.evaluate((p) => window.__cockpitTestHooks?.readPaneText(p) ?? '', pane)
}

/**
 * Clicks a pane's terminal surface until DOM focus actually lands on its xterm.js textarea. A plain
 * `.click({ force: true })` right after a layout switch is empirically flaky: xterm.js's
 * ResizeObserver-driven `fitAddon.fit()` and the CSS grid reflow it responds to race with Playwright's
 * click coordinate computation, occasionally landing the click at a stale bounding-box position that
 * misses the (deliberately near-invisible) textarea. Retrying the click itself inside `expect.poll` is
 * more robust than a single fixed `waitForTimeout` guess.
 */
export async function focusPaneTerminal(page: Page, pane: PaneIndex): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.locator('.pane-terminal').nth(pane).click({ force: true })
        return page.evaluate(() => document.activeElement?.className ?? null)
      },
      { timeout: 5000, message: `expected pane ${pane}'s xterm textarea to receive DOM focus` }
    )
    .toBe('xterm-helper-textarea')
}

/** The app-managed archive path for one session's spool copy (`<userDataDir>/archive/<id>/transcript.jsonl`
 * -- see main/archive/archiver.ts). Centralized here since it was previously duplicated verbatim across
 * app.spec.ts and archive-output.spec.ts. */
export function archivedTranscriptPath(userDataDir: string, sessionId: string): string {
  return path.join(userDataDir, 'archive', sessionId, 'transcript.jsonl')
}

/** fake-claude.js (interactive mode) must write its synthetic transcript somewhere under the *real*
 * `<home>/.claude` directory -- shared/statusline.ts's isTranscriptPathAllowed rejects any
 * transcript_path outside it (M2 FIX security), and that check is not (and should not be) test-only
 * configurable, since it is exactly the containment boundary this app depends on in production. It
 * confines every such file under `<home>/.claude/projects/cockpit-e2e/` specifically so this cleanup can
 * safely wipe just that one directory (never anything else under the developer's real `~/.claude`) after
 * each full-flow test run. */
export function cleanupFakeClaudeTranscripts(): void {
  const dir = path.join(os.homedir(), '.claude', 'projects', 'cockpit-e2e')
  fs.rmSync(dir, { recursive: true, force: true })
}
