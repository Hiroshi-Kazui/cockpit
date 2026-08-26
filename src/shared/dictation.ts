// Pure decision function for the M13 pane-local dictation input box (ADR-0015 D-6). Given the box's
// current text and the keyboard-event fields relevant to Enter/Escape handling, decides *what* the caller
// should do -- never *how*: this module never touches xterm.js's Terminal or any IPC surface (plan.md
// phase 1's test-first "Terminal も IPC も import しない" requirement), so it stays trivially unit-testable
// and keeps the submit-vs-insert-vs-nothing decision in exactly one place instead of duplicated across
// Pane.tsx's key handler.
import { normalizeInitialPromptText } from './prompt'

export interface DictationKeyInput {
  /** The dictation box's current text (before this keypress is applied by the browser's own default
   * textarea behavior -- Shift+Enter's own newline insertion is left to the caller/browser, this function
   * never edits `text` itself). */
  text: string
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  /** `KeyboardEvent.isComposing` -- true while an IME composition is in progress. An Enter that confirms
   * IME composition must not also submit/insert (ADR-0015 D-6). */
  isComposing: boolean
}

export type DictationKeyAction =
  | { kind: 'none' }
  | { kind: 'submit'; text: string }
  | { kind: 'insert'; text: string }
  | { kind: 'focusTerminal' }

/** Decides what a keydown in the dictation box should do (R-5/D-6):
 * - Escape: hand focus back to the pane's terminal, regardless of IME state (Escape and IME composition
 *   are unrelated; a user pressing Escape wants out of the box either way).
 * - Enter while composing an IME conversion: no-op, so confirming kanji conversion never also submits.
 * - Plain Enter: submit the normalized (single-line) text, unless it is empty/whitespace-only.
 * - Ctrl+Enter or Meta+Enter: insert only (no trailing CR) -- same normalization/emptiness rule as submit.
 * - Shift+Enter: no-op here; the caller/browser's own default textarea behavior inserts the newline.
 * - Every other key: no-op.
 */
export function resolveDictationKeyAction(input: DictationKeyInput): DictationKeyAction {
  if (input.key === 'Escape') {
    return { kind: 'focusTerminal' }
  }
  if (input.key !== 'Enter') {
    return { kind: 'none' }
  }
  if (input.isComposing) {
    return { kind: 'none' }
  }
  if (input.shiftKey) {
    return { kind: 'none' }
  }
  const normalized = normalizeInitialPromptText(input.text).trim()
  if (normalized.length === 0) {
    return { kind: 'none' }
  }
  if (input.ctrlKey || input.metaKey) {
    return { kind: 'insert', text: normalized }
  }
  return { kind: 'submit', text: normalized }
}
