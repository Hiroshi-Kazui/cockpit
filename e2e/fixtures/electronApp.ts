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
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// `electron`'s package default export resolves to the *path string* of the electron binary when required
// from a plain (non-Electron) Node process -- exactly what this file is (Playwright test files run under
// plain Node, never inside Electron itself) -- and only resolves to the in-process Electron API object
// when `require('electron')`/`import 'electron'` executes *inside* an already-running Electron process
// (e.g. src/main/index.ts). This is a well-known Electron packaging quirk; TypeScript's bundled ambient
// types for this package model only the in-Electron API shape, so the string case needs an explicit cast
// below (M8 followup: migration-archive-mirror.spec.ts's ELECTRON_RUN_AS_NODE seeding/readback helpers).
import electronModule from 'electron'

export const REPO_ROOT = path.resolve(__dirname, '..', '..')

const electronBinaryPath = electronModule as unknown as string

export interface LaunchedApp {
  app: ElectronApplication
  window: Page
  userDataDir: string
}

/** Launches the built app (`npm run build` must have run first -- see package.json's `test:e2e` script).
 * Uses a fresh, isolated --user-data-dir by default; a caller that needs the app to start against a
 * *pre-seeded* userData directory (e.g. migration-archive-mirror.spec.ts, which must write a legacy-shape
 * cockpit.db there before the app's own startup migration ever touches it) may pass one explicitly instead
 * -- it is used as-is (never removed/recreated), so the caller owns seeding it beforehand and cleaning it
 * up afterwards. */
export async function launchApp(userDataDir?: string): Promise<LaunchedApp> {
  const dir = userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-e2e-userdata-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${dir}`],
    cwd: REPO_ROOT
  })
  const window = await app.firstWindow()
  await window.waitForSelector('.app-header h1')
  return { app, window, userDataDir: dir }
}

/** Runs `scriptPath` (a standalone CJS script, e.g. e2e/fixtures/seed-legacy-archive-mirror.js) through the
 * project's own Electron binary in `ELECTRON_RUN_AS_NODE=1` mode -- the same technique
 * e2e/probes/td1-statusline-probe.js documents for node-pty, needed here because better-sqlite3's native
 * binary in this repo is rebuilt for *Electron's* Node ABI, not plain Node's (running these fixture scripts
 * via plain `node` would fail to load it, or worse, silently load a different, incompatible build).
 * Returns the script's stdout (trimmed); throws (surfacing stderr) if it exits non-zero -- callers must not
 * swallow a seeding/readback failure, the entire migration assertion depends on it having actually run. */
export function runElectronAsNode(scriptPath: string, args: string[] = []): string {
  return execFileSync(electronBinaryPath, [scriptPath, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  }).trim()
}

/** Closes the app and removes its isolated userData dir. */
export async function closeApp(launched: LaunchedApp): Promise<void> {
  await launched.app.close().catch(() => {
    // Best-effort -- if the app already crashed/closed, there's nothing more to do.
  })
  fs.rmSync(launched.userDataDir, { recursive: true, force: true })
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
