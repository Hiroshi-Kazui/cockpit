import { describe, expect, it } from 'vitest'
import {
  evaluationReportFileNames,
  renderEvaluationReportJson,
  renderEvaluationReportMarkdown,
  type EvaluationReportData
} from './evaluationReport'

function sampleData(overrides: Partial<EvaluationReportData> = {}): EvaluationReportData {
  return {
    id: 'eval-123',
    purposeId: 'purpose-456',
    purposeText: 'READMEにセットアップ手順を追記して',
    purposeTitle: 'README整備',
    createdAt: Date.UTC(2026, 6, 22, 12, 0, 0),
    model: 'haiku',
    smoothness: 80,
    stress: 20,
    commCost: 15,
    summary: '順調に進みました',
    suggestions: [
      { category: 'user', text: 'もっと早く相談する' },
      { category: 'environment', text: 'CIをもっと速くする' }
    ],
    inputStats: {
      sessionCount: 1,
      userMessageCount: 3,
      assistantMessageCount: 3,
      userCharsIncluded: 100,
      assistantCharsIncluded: 200,
      userCharsTotal: 100,
      assistantCharsTotal: 200,
      truncatedUser: false,
      truncatedAssistant: false
    },
    ...overrides
  }
}

describe('evaluationReportFileNames', () => {
  it('names the markdown/json files after the evaluation id only (no session/purpose data in the name)', () => {
    const names = evaluationReportFileNames('eval-123')
    expect(names).toEqual({ markdown: 'eval-123.md', json: 'eval-123.json' })
  })
})

describe('renderEvaluationReportMarkdown', () => {
  it('includes every score, the summary, and each categorized suggestion', () => {
    const md = renderEvaluationReportMarkdown(sampleData())
    expect(md).toContain('80')
    expect(md).toContain('20')
    expect(md).toContain('15')
    expect(md).toContain('順調に進みました')
    expect(md).toContain('もっと早く相談する')
    expect(md).toContain('CIをもっと速くする')
    expect(md).toContain('README整備')
  })

  it('explicitly states "no suggestions" rather than omitting the section when there are none', () => {
    const md = renderEvaluationReportMarkdown(sampleData({ suggestions: [] }))
    expect(md).toContain('改善案なし')
  })

  it('notes when input was truncated, rather than silently hiding it', () => {
    const md = renderEvaluationReportMarkdown(
      sampleData({
        inputStats: {
          sessionCount: 1,
          userMessageCount: 1,
          assistantMessageCount: 1,
          userCharsIncluded: 8000,
          assistantCharsIncluded: 0,
          userCharsTotal: 20000,
          assistantCharsTotal: 500,
          truncatedUser: true,
          truncatedAssistant: true
        }
      })
    )
    expect(md).toMatch(/切り詰め/)
  })

  it('is deterministic (pure rendering, no timestamps/randomness beyond the input data)', () => {
    const data = sampleData()
    expect(renderEvaluationReportMarkdown(data)).toBe(renderEvaluationReportMarkdown(data))
  })
})

describe('renderEvaluationReportJson', () => {
  it('round-trips the full input data as valid JSON', () => {
    const data = sampleData()
    const json = renderEvaluationReportJson(data)
    expect(JSON.parse(json)).toEqual(data)
  })
})
