import { describe, expect, it } from 'vitest'
import {
  EVALUATION_INPUT_MAX_CHARS,
  buildEvaluationInput,
  buildEvaluationPrompt,
  parseEvaluationResult,
  type EvaluationSessionInput
} from './evaluation'

describe('buildEvaluationInput', () => {
  it('is empty when there are no sessions at all', () => {
    const result = buildEvaluationInput([])
    expect(result.isEmpty).toBe(true)
    expect(result.promptBody).toBe('')
    expect(result.stats.sessionCount).toBe(0)
    expect(result.stats.userMessageCount).toBe(0)
  })

  it('is empty when every session has zero (or whitespace-only) user text, even with assistant text', () => {
    const sessions: EvaluationSessionInput[] = [
      { sessionId: 's1', userTexts: ['   ', ''], assistantTexts: ['アシスタントの応答'] }
    ]
    const result = buildEvaluationInput(sessions)
    expect(result.isEmpty).toBe(true)
    expect(result.stats.sessionCount).toBe(1)
    expect(result.stats.assistantMessageCount).toBe(1)
  })

  it('is not empty when at least one session has genuine user text', () => {
    const sessions: EvaluationSessionInput[] = [
      { sessionId: 's1', userTexts: ['READMEを直して'], assistantTexts: ['了解しました'] }
    ]
    const result = buildEvaluationInput(sessions)
    expect(result.isEmpty).toBe(false)
    expect(result.promptBody).toContain('READMEを直して')
    expect(result.promptBody).toContain('了解しました')
    expect(result.stats.userMessageCount).toBe(1)
    expect(result.stats.assistantMessageCount).toBe(1)
    expect(result.stats.truncatedUser).toBe(false)
    expect(result.stats.truncatedAssistant).toBe(false)
  })

  it('excerpts long assistant text (head + tail) instead of including it verbatim', () => {
    const longAssistantText = 'A'.repeat(1000)
    const sessions: EvaluationSessionInput[] = [
      { sessionId: 's1', userTexts: ['目的です'], assistantTexts: [longAssistantText] }
    ]
    const result = buildEvaluationInput(sessions)
    expect(result.isEmpty).toBe(false)
    expect(result.promptBody).not.toContain(longAssistantText)
    expect(result.stats.assistantCharsIncluded).toBeLessThan(longAssistantText.length)
    expect(result.stats.assistantCharsTotal).toBe(longAssistantText.length)
  })

  it('is deterministic: same input always produces the same output', () => {
    const sessions: EvaluationSessionInput[] = [
      { sessionId: 's1', userTexts: ['hello', 'world'], assistantTexts: ['ok', 'done'] }
    ]
    const a = buildEvaluationInput(sessions)
    const b = buildEvaluationInput(sessions)
    expect(a).toEqual(b)
  })

  it('truncates user text at the total cap and reports truncatedUser, with no room left for assistant text', () => {
    const hugeUserText = 'う'.repeat(EVALUATION_INPUT_MAX_CHARS + 500)
    const sessions: EvaluationSessionInput[] = [
      { sessionId: 's1', userTexts: [hugeUserText], assistantTexts: ['アシスタント応答'] }
    ]
    const result = buildEvaluationInput(sessions)
    expect(result.isEmpty).toBe(false)
    expect(result.stats.truncatedUser).toBe(true)
    expect(result.stats.userCharsIncluded).toBeLessThanOrEqual(EVALUATION_INPUT_MAX_CHARS)
    expect(result.promptBody.length).toBeLessThanOrEqual(EVALUATION_INPUT_MAX_CHARS + 50)
    expect(result.stats.truncatedAssistant).toBe(true)
    expect(result.stats.assistantCharsIncluded).toBe(0)
  })

  it('truncates assistant excerpts once the remaining budget after user text is exhausted', () => {
    const userText = 'ほどほどの長さのユーザー発言です。'.repeat(50)
    const manyAssistantTexts = Array.from({ length: 100 }, (_, i) => `応答その${i}: ` + 'x'.repeat(200))
    const sessions: EvaluationSessionInput[] = [
      { sessionId: 's1', userTexts: [userText], assistantTexts: manyAssistantTexts }
    ]
    const result = buildEvaluationInput(sessions)
    expect(result.stats.truncatedAssistant).toBe(true)
    expect(result.promptBody.length).toBeLessThanOrEqual(EVALUATION_INPUT_MAX_CHARS + 200)
  })

  it('aggregates across multiple sessions in order', () => {
    const sessions: EvaluationSessionInput[] = [
      { sessionId: 's1', userTexts: ['最初のセッション'], assistantTexts: [] },
      { sessionId: 's2', userTexts: ['次のセッション'], assistantTexts: [] }
    ]
    const result = buildEvaluationInput(sessions)
    expect(result.stats.sessionCount).toBe(2)
    expect(result.stats.userMessageCount).toBe(2)
    const firstIdx = result.promptBody.indexOf('最初のセッション')
    const secondIdx = result.promptBody.indexOf('次のセッション')
    expect(firstIdx).toBeGreaterThanOrEqual(0)
    expect(secondIdx).toBeGreaterThan(firstIdx)
  })
})

describe('buildEvaluationPrompt', () => {
  it('embeds the purpose text and the built input body verbatim, and demands JSON-only output', () => {
    const input = buildEvaluationInput([
      { sessionId: 's1', userTexts: ['READMEを直して'], assistantTexts: ['了解しました'] }
    ])
    const prompt = buildEvaluationPrompt('READMEの整備', input.promptBody)
    expect(prompt).toContain('READMEの整備')
    expect(prompt).toContain('READMEを直して')
    expect(prompt).toContain('smoothness')
    expect(prompt).toContain('stress')
    expect(prompt).toContain('commCost')
    expect(prompt).toContain('JSON')
  })

  it('handles an empty purpose text without throwing', () => {
    expect(() => buildEvaluationPrompt('', 'body')).not.toThrow()
  })
})

describe('parseEvaluationResult', () => {
  it('parses a well-formed JSON response', () => {
    const raw = JSON.stringify({
      smoothness: 80,
      stress: 20,
      commCost: 15,
      summary: '順調に進みました',
      suggestions: [{ category: 'user', text: 'もっと早く相談する' }]
    })
    const result = parseEvaluationResult(raw)
    expect(result).toEqual({
      ok: true,
      smoothness: 80,
      stress: 20,
      commCost: 15,
      summary: '順調に進みました',
      suggestions: [{ category: 'user', text: 'もっと早く相談する' }]
    })
  })

  it('tolerates surrounding prose / markdown code fences around the JSON object', () => {
    const raw =
      '以下が評価結果です。\n```json\n' +
      JSON.stringify({ smoothness: 50, stress: 50, commCost: 50, summary: '', suggestions: [] }) +
      '\n```\nご確認ください。'
    const result = parseEvaluationResult(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.smoothness).toBe(50)
    }
  })

  it('clamps out-of-range scores into 0-100 and rounds fractional scores', () => {
    const raw = JSON.stringify({ smoothness: -10, stress: 150, commCost: 33.6, summary: '', suggestions: [] })
    const result = parseEvaluationResult(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.smoothness).toBe(0)
      expect(result.stress).toBe(100)
      expect(result.commCost).toBe(34)
    }
  })

  it('ignores unknown/extra fields (tolerant parser)', () => {
    const raw = JSON.stringify({
      smoothness: 10,
      stress: 10,
      commCost: 10,
      summary: 'x',
      suggestions: [],
      unknownField: 'should be ignored',
      nested: { also: 'ignored' }
    })
    const result = parseEvaluationResult(raw)
    expect(result.ok).toBe(true)
  })

  it('defaults a missing/invalid summary to an empty string rather than failing', () => {
    const raw = JSON.stringify({ smoothness: 10, stress: 10, commCost: 10, suggestions: [] })
    const result = parseEvaluationResult(raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.summary).toBe('')
  })

  it('defaults a missing/invalid suggestions array to an empty array (0 suggestions is valid)', () => {
    const raw = JSON.stringify({ smoothness: 10, stress: 10, commCost: 10, summary: 'x' })
    const result = parseEvaluationResult(raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.suggestions).toEqual([])
  })

  it('drops individual suggestion entries with an invalid category instead of failing the whole parse', () => {
    const raw = JSON.stringify({
      smoothness: 10,
      stress: 10,
      commCost: 10,
      summary: 'x',
      suggestions: [
        { category: 'user', text: '有効な提案' },
        { category: 'bogus', text: '無効なカテゴリ' },
        { category: 'environment', text: '' }, // empty text dropped
        { text: 'カテゴリなし' } // missing category dropped
      ]
    })
    const result = parseEvaluationResult(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.suggestions).toEqual([{ category: 'user', text: '有効な提案' }])
    }
  })

  it('fails with a reason when the output contains no JSON object at all', () => {
    const result = parseEvaluationResult('sorry, I cannot help with that')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0)
  })

  it('fails with a reason when the output is malformed JSON', () => {
    const result = parseEvaluationResult('{ "smoothness": 10, "stress": }')
    expect(result.ok).toBe(false)
  })

  it('fails (never silently defaults to 0) when a required score field is missing entirely', () => {
    const raw = JSON.stringify({ stress: 10, commCost: 10, summary: 'x', suggestions: [] })
    const result = parseEvaluationResult(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('smoothness')
  })

  it('fails when a required score field is a non-numeric string', () => {
    const raw = JSON.stringify({
      smoothness: 'high',
      stress: 10,
      commCost: 10,
      summary: 'x',
      suggestions: []
    })
    const result = parseEvaluationResult(raw)
    expect(result.ok).toBe(false)
  })
})
