// Single canonical definition of the E2E-only `window.__cockpitTestHooks` contract (CLAUDE.md: "IPC は
// 型付き契約... channel 名と payload 型を1箇所で定義" -- this is the one non-IPC exception to that same
// principle: a plain same-realm `window` property, not a contextBridge API, but it still deserves exactly
// one canonical shape rather than two independently-maintained structural types on either side of the
// renderer/e2e boundary).
//
// Implemented by src/renderer/src/testing/terminalProbe.ts (assigns `window.__cockpitTestHooks` once at
// module load) and consumed by e2e/fixtures/electronApp.ts's `readPaneTerminalText` (via
// `page.evaluate`). See terminalProbe.ts's header comment for why this hook exists at all (the canvas
// renderer paints to a `<canvas>`, never to the DOM, so Playwright's `.textContent`/`toContainText()`
// cannot observe rendered terminal output). Exposes only a reader that returns a plain string -- no
// Node/Electron API, no xterm.js type surface reaches across the boundary.
import type { PaneIndex } from './ipc'

export interface CockpitTestHooks {
  /** Returns pane `pane`'s currently-rendered xterm.js buffer content (rows joined with `\n`), or `''` if
   * that pane has no terminal registered yet. */
  readPaneText: (pane: PaneIndex) => string
}

declare global {
  interface Window {
    __cockpitTestHooks?: CockpitTestHooks
  }
}
