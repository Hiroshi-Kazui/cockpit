// Global keyboard shortcut for moving keyboard focus between panes (M5, AC "キーボードでのペイン間
// フォーカス移動"). Binds Ctrl(or Cmd)+1..4 -> focus pane 0..3, with no other modifier held.
//
// Design rationale (TD-6 implementer discretion -- spec has no concrete keybinding): a rare, modifier-
// required chord was chosen specifically so spec §4.1's "生のpty入出力を素通しする" guarantee for
// *ordinary* interactive keystrokes (slash commands, permission-confirmation single keypresses, arrow-key
// menus, Ctrl+C/Ctrl+R, etc.) is untouched -- only this one reserved combination is ever intercepted.
// Ctrl+<digit> for direct-address pane/tab switching mirrors an existing, widely-recognized convention
// (browser tabs, VS Code editor groups, tmux windows) that terminal apps embedded inside that chrome
// already coexist with; no currently-documented claude CLI keyboard shortcut uses Ctrl+<digit>. With only
// 4 panes, direct-address (jump straight to pane N) is simpler and more discoverable than a directional
// (Ctrl+Arrow) scheme.
//
// Registered on `window` in the *capture* phase specifically so it observes the keystroke before
// xterm.js's own per-terminal keydown handler (attached directly on each terminal's hidden textarea,
// bubble phase) ever does -- Ctrl+1..4 is therefore always consumed for pane-switching, by design, even
// while a pane's terminal already has keyboard focus (that is the whole point: jumping focus *away* from
// the currently-focused pane to another one without reaching for the mouse).
import { useEffect } from 'react'
import type { PaneIndex } from '@shared/ipc'

const DIGIT_TO_PANE: Readonly<Record<string, PaneIndex>> = { '1': 0, '2': 1, '3': 2, '4': 3 }

/**
 * @param visiblePanes Only these panes are reachable by the shortcut -- a hidden pane (e.g. pane 2 while
 *   the 'single' layout shows only pane 0) has nothing visible to confirm a focus change against, so the
 *   shortcut is a no-op (and does not even preventDefault) for a currently-invisible pane's digit.
 * @param getFocusFn Looks up the currently-registered focus callback for a pane, or undefined if that
 *   pane's terminal has not mounted (yet). Called on every matching keydown rather than captured once, so
 *   it always sees the latest registration.
 * @param enabled M5: false while a modal overlay (e.g. SessionBrowser, `role="dialog" aria-modal="true"`)
 *   is open, so this global capture-phase listener cannot steal focus away from the dialog and out to a
 *   pane's xterm behind it -- that would contradict `aria-modal`'s promise to assistive tech/keyboard
 *   users that everything outside the dialog is inert while it is open. Defaults to true so every other
 *   caller/existing behavior is unchanged.
 */
export function usePaneFocusShortcuts(
  visiblePanes: ReadonlySet<PaneIndex>,
  getFocusFn: (pane: PaneIndex) => (() => void) | undefined,
  enabled: boolean = true
): void {
  useEffect(() => {
    if (!enabled) return
    function handleKeyDown(e: KeyboardEvent): void {
      // Excludes Shift/Alt so this never shadows an unrelated combination that also happens to hold
      // Ctrl/Cmd (e.g. Ctrl+Shift+1).
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
      const pane = DIGIT_TO_PANE[e.key]
      if (pane === undefined || !visiblePanes.has(pane)) return
      const focusFn = getFocusFn(pane)
      if (!focusFn) return
      e.preventDefault()
      e.stopPropagation()
      focusFn()
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [visiblePanes, getFocusFn, enabled])
}
