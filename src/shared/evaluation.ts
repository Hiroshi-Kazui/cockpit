// Pure functions for the M9 purpose-completion evaluation pipeline (spec §2's deferred "事後分析",
// ADR-0010 D-2/D-8): deterministically building a bounded LLM input from archived transcript turns, the
// exact prompt sent to the headless `claude -p --model <model>` one-shot (main/evaluation/evaluationRunner.ts
// sends this via stdin only -- never argv, mirroring shared/title.ts's buildTitlePrompt/titleGenerator.ts
// TD-5 discipline), and a tolerant parser for the JSON response (unknown fields ignored, missing/invalid
// summary/suggestions default rather than fail, but a missing/invalid required score field fails the parse
// outright -- CLAUDE.md/ADR-0010 D-2: "無音の 0 点評価にならない").
export interface EvaluationSessionInput {
  sessionId: string
  /** Every genuine chat turn's text, in transcript order (already extracted by the caller from the spool
   * archive via shared/jsonl.ts's parseJsonlLineForDisplay -- this module performs no I/O and knows nothing
   * about JSONL). May contain empty/whitespace-only entries; this module filters those out itself. */
  userTexts: readonly string[]
  assistantTexts: readonly string[]
}

export interface EvaluationInputStats {
  sessionCount: number
  userMessageCount: number
  assistantMessageCount: number
  /** Characters actually included in the prompt body vs. the true total before any truncation/excerpting
   * -- recorded so a truncated evaluation is never silently indistinguishable from a complete one (plan.md
   * risk "transcript 肥大": "切ったことは input_stats に記録し隠さない"). */
  userCharsIncluded: number
  assistantCharsIncluded: number
  userCharsTotal: number
  assistantCharsTotal: number
  truncatedUser: boolean
  truncatedAssistant: boolean
}

export interface EvaluationBuiltInput {
  /** spec §4.2/ADR-0010 D-8: true when there is no genuine user text at all (no sessions, or every
   * session's user text is empty/whitespace-only) -- the caller must not invoke the LLM in this case and
   * instead confirms the evaluation as 'skipped'. */
  isEmpty: boolean
  /** The transcript-excerpt section embedded into the final prompt (buildEvaluationPrompt below). Empty
   * string when isEmpty is true (there is nothing to embed). */
  promptBody: string
  stats: EvaluationInputStats
}

/** Total character budget for the transcript-excerpt section of the prompt (D-8 "総量上限"). Generous
 * enough for a real evaluation while keeping a single headless haiku call's token cost bounded and
 * predictable regardless of how large the underlying archived transcript grew. */
export const EVALUATION_INPUT_MAX_CHARS = 8000

/** Per-assistant-turn head/tail excerpt lengths (D-8 "アシスタント発言は先頭/末尾抜粋") -- long assistant
 * replies (tool output, long explanations) are excerpted rather than included verbatim so a handful of
 * long turns cannot alone exhaust the whole budget before any user text (which is prioritized) is even
 * considered. */
export const EVALUATION_ASSISTANT_HEAD_CHARS = 200
export const EVALUATION_ASSISTANT_TAIL_CHARS = 200

function excerptText(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars) return text
  return `${text.slice(0, headChars)}…(中略)…${text.slice(text.length - tailChars)}`
}

/**
 * D-8: deterministically builds the bounded transcript-excerpt input for one purpose's evaluation from
 * every linked session's extracted chat turns. User text is included in full, in order, up to the total
 * character budget (EVALUATION_INPUT_MAX_CHARS) -- "ユーザ発言を全量優先". Whatever budget remains after
 * user text is then filled with head/tail excerpts of assistant text, in order, also capped by the
 * remaining budget. Every truncation decision is recorded in `stats` rather than hidden. Pure and
 * deterministic: the same `sessions` array always produces byte-identical output.
 */
export function buildEvaluationInput(
  sessions: readonly EvaluationSessionInput[]
): EvaluationBuiltInput {
  const userEntries: Array<{ sessionId: string; text: string }> = []
  const assistantEntries: Array<{ sessionId: string; text: string }> = []
  let userCharsTotal = 0
  let assistantCharsTotal = 0

  for (const session of sessions) {
    for (const text of session.userTexts) {
      const trimmed = text.trim()
      if (trimmed.length === 0) continue
      userEntries.push({ sessionId: session.sessionId, text: trimmed })
      userCharsTotal += trimmed.length
    }
    for (const text of session.assistantTexts) {
      const trimmed = text.trim()
      if (trimmed.length === 0) continue
      assistantEntries.push({ sessionId: session.sessionId, text: trimmed })
      assistantCharsTotal += trimmed.length
    }
  }

  const isEmpty = sessions.length === 0 || userEntries.length === 0

  if (isEmpty) {
    return {
      isEmpty: true,
      promptBody: '',
      stats: {
        sessionCount: sessions.length,
        userMessageCount: userEntries.length,
        assistantMessageCount: assistantEntries.length,
        userCharsIncluded: 0,
        assistantCharsIncluded: 0,
        userCharsTotal,
        assistantCharsTotal,
        truncatedUser: false,
        truncatedAssistant: false
      }
    }
  }

  const userBlockFull = userEntries
    .map((entry, i) => `#${i + 1} [${entry.sessionId}]\n${entry.text}`)
    .join('\n\n')
  let userBlock = userBlockFull
  let truncatedUser = false
  if (userBlock.length > EVALUATION_INPUT_MAX_CHARS) {
    userBlock = userBlock.slice(0, EVALUATION_INPUT_MAX_CHARS)
    truncatedUser = true
  }

  const remaining = EVALUATION_INPUT_MAX_CHARS - userBlock.length
  let assistantBlock = ''
  let truncatedAssistant = false

  if (assistantEntries.length > 0) {
    if (remaining <= 0) {
      truncatedAssistant = true
    } else {
      const excerptsFull = assistantEntries
        .map(
          (entry) =>
            `[${entry.sessionId}]\n${excerptText(entry.text, EVALUATION_ASSISTANT_HEAD_CHARS, EVALUATION_ASSISTANT_TAIL_CHARS)}`
        )
        .join('\n\n')
      if (excerptsFull.length > remaining) {
        assistantBlock = excerptsFull.slice(0, remaining)
        truncatedAssistant = true
      } else {
        assistantBlock = excerptsFull
      }
    }
  }

  const sections = [`[ユーザ発言]\n${userBlock}`]
  if (assistantBlock.length > 0) {
    sections.push(`[アシスタント発言抜粋]\n${assistantBlock}`)
  }

  return {
    isEmpty: false,
    promptBody: sections.join('\n\n'),
    stats: {
      sessionCount: sessions.length,
      userMessageCount: userEntries.length,
      assistantMessageCount: assistantEntries.length,
      userCharsIncluded: userBlock.length,
      assistantCharsIncluded: assistantBlock.length,
      userCharsTotal,
      assistantCharsTotal,
      truncatedUser,
      truncatedAssistant
    }
  }
}

/**
 * The exact prompt text sent to the headless `claude -p --model <model>` evaluation one-shot (ADR-0010
 * D-2). Only ever passed to the child process via stdin (main/evaluation/evaluationRunner.ts) -- never
 * argv (TD-5 injection invariant, pinned by evaluationRunner.test.ts the same way titleGenerator.test.ts
 * pins generateTitle's). `purposeText`/`promptBody` are user-authored/derived and are embedded verbatim;
 * that is safe here specifically because this function only ever produces a *string*, which the runner
 * writes to a pipe, never interpolates into a shell command line.
 */
export function buildEvaluationPrompt(purposeText: string, promptBody: string): string {
  return [
    '以下はある「目的」に関する claude CLI とユーザーのやり取りの抜粋です。',
    'この目的の達成プロセスを、次の3軸で評価してください（各 0〜100 の整数）:',
    '- smoothness: 順調度（作業がスムーズに進んだか。高いほど順調）',
    '- stress: ストレス度（ユーザーの発言から読み取れる苛立ち・焦り・繰り返しの訂正など。高いほどストレスが大きい）',
    '- commCost: コミュニケーションコスト（意図が伝わるまでの往復・説明の手間。高いほどコストが大きい）',
    '',
    '改善案があれば、次の2つのカテゴリのいずれかを付けて挙げてください（0件でもかまいません）:',
    '- user: ユーザー側の思考・行動に関する改善案',
    '- environment: ハーネス設計・開発環境整備に関する改善案',
    '',
    '出力は次のJSON形式のみとし、それ以外の文章は一切出力しないでください:',
    '{"smoothness": 0-100の整数, "stress": 0-100の整数, "commCost": 0-100の整数, ' +
      '"summary": "短い総評（日本語1〜2文）", ' +
      '"suggestions": [{"category": "user"|"environment", "text": "..."}]}',
    '',
    `目的: ${purposeText.trim().length > 0 ? purposeText : '(未設定)'}`,
    '',
    promptBody
  ].join('\n')
}

export interface EvaluationSuggestion {
  category: 'user' | 'environment'
  text: string
}

export type EvaluationParseResult =
  | {
      ok: true
      smoothness: number
      stress: number
      commCost: number
      summary: string
      suggestions: EvaluationSuggestion[]
    }
  | { ok: false; reason: string }

/** Scans `raw` for the first balanced top-level `{...}` object (tolerating braces inside string literals)
 * and JSON.parses just that substring -- so a response wrapped in prose or a markdown code fence (models
 * do not always obey "出力はJSON形式のみ" strictly) can still be recovered. Returns null if no balanced
 * object is found or it fails to parse. */
function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escapeNext = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escapeNext) {
        escapeNext = false
      } else if (ch === '\\') {
        escapeNext = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        const candidate = raw.slice(start, i + 1)
        try {
          return JSON.parse(candidate)
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** Coerces a raw JSON value into a 0-100 integer score, or null if it cannot be interpreted as a finite
 * number at all (missing field, wrong type, non-numeric string) -- callers treat null as "this required
 * field is absent", never as "0" (CLAUDE.md/ADR-0010: silent failure prohibited, no silent 0-point
 * default). Out-of-range and fractional values ARE tolerated and clamped/rounded (the mirror-image
 * "寛容パーサ" half of the same requirement). */
function clampScore(value: unknown): number | null {
  let num: number | null = null
  if (typeof value === 'number' && Number.isFinite(value)) {
    num = value
  } else if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) num = parsed
  }
  if (num === null) return null
  return Math.min(100, Math.max(0, Math.round(num)))
}

const VALID_SUGGESTION_CATEGORIES = new Set(['user', 'environment'])

/** Filters `value` down to well-formed suggestion entries, silently dropping (not failing the whole
 * parse over) any entry with an unrecognized category or empty/missing text -- R-3 "0件も許容". A
 * non-array/missing `suggestions` field is treated the same as "zero suggestions", not an error. */
function parseSuggestions(value: unknown): EvaluationSuggestion[] {
  if (!Array.isArray(value)) return []
  const result: EvaluationSuggestion[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const category = record['category']
    const text = record['text']
    if (typeof category !== 'string' || !VALID_SUGGESTION_CATEGORIES.has(category)) continue
    if (typeof text !== 'string' || text.trim().length === 0) continue
    result.push({ category: category as EvaluationSuggestion['category'], text: text.trim() })
  }
  return result
}

/**
 * Tolerant parser for the headless evaluation LLM's response (ADR-0010 D-2/R-6): unknown fields are
 * ignored, a missing/invalid `summary` defaults to `''`, a missing/invalid `suggestions` defaults to
 * `[]` -- but the three required score fields (smoothness/stress/commCost) must each resolve to a finite
 * number or the whole parse fails with a reason (never silently defaulted to 0, since a claude-side
 * failure to answer must surface as a visible `error` state, not an indistinguishable worst-possible
 * score -- CLAUDE.md silent-failure prohibition / ADR-0010 risk "無音の 0 点扱いはしない"). Never throws.
 */
export function parseEvaluationResult(rawOutput: string): EvaluationParseResult {
  const parsed = extractJsonObject(rawOutput)
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: '評価結果からJSONオブジェクトを抽出できませんでした' }
  }
  const record = parsed as Record<string, unknown>
  const smoothness = clampScore(record['smoothness'])
  const stress = clampScore(record['stress'])
  const commCost = clampScore(record['commCost'])

  const missing: string[] = []
  if (smoothness === null) missing.push('smoothness')
  if (stress === null) missing.push('stress')
  if (commCost === null) missing.push('commCost')
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `評価結果に必須フィールドが欠けているか不正です: ${missing.join(', ')}`
    }
  }

  const summaryRaw = record['summary']
  const summary = typeof summaryRaw === 'string' ? summaryRaw.trim() : ''
  const suggestions = parseSuggestions(record['suggestions'])

  return { ok: true, smoothness, stress, commCost, summary, suggestions }
}
