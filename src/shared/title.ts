// Pure title helpers for M4 purpose-title generation (spec §4.2: `claude -p --model haiku` one-shot,
// "claude.ai の「最近の項目」相当の粒度、20字程度"). Two call sites share this shape: the prompt sent
// to the headless `-p` invocation, and the fallback truncation applied both when generation fails and
// to normalize whatever the model actually returned (it may not obey the "20字程度" instruction).
export const TITLE_MAX_LENGTH = 20

/**
 * Collapse whitespace/newlines to single spaces, trim, and clip to `maxLength` characters (default
 * ~20, spec §4.2). Appends an ellipsis when the collapsed text was longer than the limit so a clipped
 * title is visually distinguishable from a naturally-short one. Empty/whitespace-only input yields ''.
 */
export function truncateTitle(text: string, maxLength: number = TITLE_MAX_LENGTH): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return ''
  if (collapsed.length <= maxLength) return collapsed
  return collapsed.slice(0, maxLength) + '…'
}

/** The exact prompt text sent to the headless `claude -p --model haiku` title generator (spec §4.2). */
export function buildTitlePrompt(purposeText: string): string {
  return (
    '次の目的を要約して、20字程度の短い日本語タイトルを1行だけ出力してください' +
    '（タイトル以外は出力しないこと）。目的: ' +
    purposeText
  )
}

/**
 * Normalizes raw stdout from the headless `-p` title generation into a usable title: takes the first
 * non-blank line (models sometimes preface output with blank lines) and applies the same
 * collapse-and-clip as the fallback truncation, so a title that ignored the "20字程度" instruction is
 * still bounded. Returns null when the output has no usable content (caller treats this as a failure
 * and falls back to `truncateTitle` on the original purpose text).
 */
export function sanitizeGeneratedTitle(rawOutput: string): string | null {
  const firstNonBlankLine = rawOutput.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ''
  const cleaned = truncateTitle(firstNonBlankLine)
  return cleaned.length > 0 ? cleaned : null
}
