// E2E-only per-pane terminal observation registry (no production behavior change). Mirrors this
// codebase's existing per-pane capability registration pattern -- Pane.tsx registers/unregisters its
// terminal-focus callback with App.tsx's `registerPaneFocus` the same way (register on mount, explicit
// `null` unregister on cleanup) -- rather than the ad-hoc DOM-node expando this replaces.
//
// Why this exists at all: the canvas renderer (see usePtyPane.ts) paints terminal output to a <canvas>,
// never to the DOM, so Playwright's `.textContent`/`toContainText()` against `.pane-terminal` cannot
// observe rendered terminal content once canvas is active. `readPaneText` reads xterm.js's own buffer API
// instead, and is the *only* thing exposed across the renderer/e2e boundary (via `window.__cockpitTestHooks`,
// contract defined once in shared/testHooks.ts) -- callers on the Playwright side get back a plain string,
// never an xterm.js object, so no structural typing of xterm's Terminal/Buffer shape needs to be
// duplicated on that side.
//
// This stays a plain renderer-internal object assigned onto `window` (not through preload's
// contextBridge): it adds no Node/Electron API surface, and the only thing reachable through it is read
// access to this same process's own already-rendered terminal text, which the canvas already paints
// visually. `nodeIntegration:false`/`contextIsolation:true`/`sandbox:true` are unaffected -- main world
// already carries the full `window.cockpit` IPC surface via preload; this adds nothing to it.
import type { Terminal } from '@xterm/xterm'
import type { PaneIndex } from '@shared/ipc'
import type { CockpitTestHooks } from '@shared/testHooks'

const registry: Partial<Record<PaneIndex, Terminal>> = {}

/** Registers (or, given `null`, unregisters) pane `pane`'s live xterm.js Terminal instance. Called once by
 * usePtyPane's mount effect and again with `null` from that effect's cleanup. */
export function registerPaneTerminal(pane: PaneIndex, term: Terminal | null): void {
  if (term) {
    registry[pane] = term
  } else {
    delete registry[pane]
  }
}

function readPaneText(pane: PaneIndex): string {
  const term = registry[pane]
  if (!term) return ''
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buffer.length; i += 1) {
    const line = buffer.getLine(i)
    if (line) lines.push(line.translateToString(true))
  }
  return lines.join('\n')
}

const hooks: CockpitTestHooks = { readPaneText }
window.__cockpitTestHooks = hooks
