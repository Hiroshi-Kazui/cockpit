// Pure helper for normalizing a user-authored purpose/prompt text before it is sent as literal
// terminal input to claude's pty (spec §4.2 step 3: initial prompt auto-send). PurposeDialog's textarea
// allows internal newlines (Shift+Enter, paste); writing those as literal newlines followed by a
// trailing '\r' would look to the claude TUI like several separate Enter presses mid-composition,
// submitting the prompt prematurely. Collapsing internal newlines to a single space keeps the whole
// purpose text as one line so the trailing '\r' is the only submit signal. Leading/trailing trim is the
// caller's responsibility (already applied client-side by PurposeDialog) and is intentionally left
// alone here.
export function normalizeInitialPromptText(text: string): string {
  return text.replace(/[ \t]*[\r\n]+[ \t]*/g, ' ')
}
