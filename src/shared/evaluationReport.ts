// Pure rendering of the M9 evaluation report (Markdown + JSON) written to the user-configured output
// root (ADR-0010 D-5). SQLite is the source of truth; this module's output is always a byte-identical,
// re-derivable projection of a single `evaluations` row -- no I/O, no side effects, so it is exercised
// directly with plain data here rather than through a real filesystem.
import type { EvaluationInputStats, EvaluationSuggestion } from './evaluation'

export interface EvaluationReportData {
  id: string
  purposeId: string
  purposeText: string
  purposeTitle: string | null
  createdAt: number
  model: string | null
  smoothness: number
  stress: number
  commCost: number
  summary: string
  suggestions: readonly EvaluationSuggestion[]
  inputStats: EvaluationInputStats
}

/** D-5 "eval_id 単位の新規書き出しのみ": every report is named solely after its (always-fresh, UUID)
 * evaluation id -- there is no naming scheme under which a later write could collide with an earlier
 * one, so the coordinator (main/evaluation/evaluationCoordinator.ts) never needs to overwrite or delete
 * an existing report file. */
export function evaluationReportFileNames(evalId: string): { markdown: string; json: string } {
  return { markdown: `${evalId}.md`, json: `${evalId}.json` }
}

const SUGGESTION_CATEGORY_LABEL: Record<EvaluationSuggestion['category'], string> = {
  user: 'ユーザー',
  environment: '環境'
}

export function renderEvaluationReportMarkdown(data: EvaluationReportData): string {
  const lines: string[] = []
  lines.push('# 目的評価レポート')
  lines.push('')
  lines.push(`- 評価ID: ${data.id}`)
  lines.push(`- 目的ID: ${data.purposeId}`)
  lines.push(`- 目的: ${data.purposeTitle ?? '(未設定)'} — ${data.purposeText || '(未設定)'}`)
  lines.push(`- 評価日時 (UTC): ${new Date(data.createdAt).toISOString()}`)
  lines.push(`- モデル: ${data.model ?? '(unknown)'}`)
  lines.push('')
  lines.push('## スコア（0〜100）')
  lines.push(`- 順調度（高いほど良い）: ${data.smoothness}`)
  lines.push(`- ストレス度（高いほど悪い）: ${data.stress}`)
  lines.push(`- コミュニケーションコスト（高いほど悪い）: ${data.commCost}`)
  lines.push('')
  lines.push('## 総評')
  lines.push(data.summary.length > 0 ? data.summary : '(総評なし)')
  lines.push('')
  lines.push('## 改善案')
  if (data.suggestions.length === 0) {
    lines.push('改善案なし')
  } else {
    for (const suggestion of data.suggestions) {
      lines.push(`- [${SUGGESTION_CATEGORY_LABEL[suggestion.category]}] ${suggestion.text}`)
    }
  }
  lines.push('')
  lines.push('## 入力統計')
  lines.push(`- セッション数: ${data.inputStats.sessionCount}`)
  lines.push(`- ユーザー発言数: ${data.inputStats.userMessageCount}`)
  lines.push(`- アシスタント発言数: ${data.inputStats.assistantMessageCount}`)
  lines.push(
    `- ユーザー発言文字数（採用/合計）: ${data.inputStats.userCharsIncluded}/${data.inputStats.userCharsTotal}`
  )
  lines.push(
    `- アシスタント発言文字数（採用/合計）: ${data.inputStats.assistantCharsIncluded}/${data.inputStats.assistantCharsTotal}`
  )
  if (data.inputStats.truncatedUser || data.inputStats.truncatedAssistant) {
    lines.push('- 注記: 入力上限のため一部の発言が切り詰められました')
  }
  lines.push('')
  lines.push(
    'この評価はLLMによる主観的な単発判定であり、精度は保証されません。傾向は週次/月次の遷移でご確認ください。'
  )
  return lines.join('\n')
}

/** Deterministic JSON serialization of the full report data -- deliberately just `data` verbatim (not a
 * re-shaped subset) so the JSON report is always exactly what was stored, byte-for-byte reproducible from
 * SQLite (ADR-0010 D-5). */
export function renderEvaluationReportJson(data: EvaluationReportData): string {
  return JSON.stringify(data, null, 2)
}
