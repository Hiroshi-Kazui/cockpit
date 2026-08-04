// Purpose-completion evaluation dialog (M9, spec §2/§4.6 deferred "事後分析", ADR-0010 R-2/R-3/R-7):
// radar chart (3 axes, D-3 "面積が大きい=良い" polarity) + total evaluation + categorized suggestions +
// pending/error/skipped state + re-run action. Rendered as an overlay sibling of PaneGrid in App.tsx (the
// same mounting convention SessionBrowser.tsx/ArchiveOutputSettings.tsx already established), opened
// automatically right after a "完了" action (Pane.tsx) and re-openable afterward on demand.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { RadarChart, type RadarAxis } from './RadarChart'
import { useEvaluationForPurpose } from '../hooks/useEvaluationForPurpose'

interface EvaluationDialogProps {
  purposeId: string
  purposeTitle: string | null
  onClose: () => void
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const FOCUSABLE_SELECTOR = 'button:not(:disabled)'

const CATEGORY_LABEL: Record<'user' | 'environment', string> = {
  user: 'ユーザー側の思考・行動',
  environment: 'ハーネス設計・開発環境整備'
}

export function EvaluationDialog({
  purposeId,
  purposeTitle,
  onClose
}: EvaluationDialogProps): React.JSX.Element {
  const { evaluation, loadError } = useEvaluationForPurpose(purposeId)
  const [rerunError, setRerunError] = useState<string | null>(null)
  const [rerunning, setRerunning] = useState(false)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  // M9 FIX (iter1 blocking, manual-open half): "評価を見る" stays available for any completed purpose
  // regardless of the current evaluation_enabled toggle (Pane.tsx), including one that was never evaluated
  // because the toggle was off at completion time -- in that case `evaluation` never arrives (no row was
  // ever created), so without this check the dialog would show "読み込み中…" forever. `null` = not
  // resolved yet (default to the pre-existing loading copy, same as before this fix).
  const [evaluationEnabled, setEvaluationEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    window.cockpit.appSettings
      .get()
      .then((settings) => {
        if (!cancelled) setEvaluationEnabled(settings.evaluationEnabled)
      })
      .catch((err: unknown) => {
        // Never silently leave this unresolved forever if the read fails -- fall back to the "enabled"
        // assumption so we keep showing the ordinary loading copy rather than falsely claiming "disabled".
        console.error('[evaluation-dialog] failed to read evaluation settings', err)
        if (!cancelled) setEvaluationEnabled(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleRerun(): Promise<void> {
    setRerunError(null)
    setRerunning(true)
    try {
      await window.cockpit.evaluation.rerun({ purposeId })
    } catch (err) {
      setRerunError(describeError(err))
    } finally {
      setRerunning(false)
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const container = dialogRef.current
    if (!container) return
    const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  // D-3: DB/IPC keep the requirement-literal polarity (stress/commCost = 高いほど悪い); only the radar's
  // *display* is normalized to "面積が大きい = 良い" here, at the render boundary -- raw values are still
  // shown alongside as text so the requirement's own vocabulary stays checkable.
  const axes: RadarAxis[] = []
  if (evaluation?.status === 'ok') {
    const { smoothness, stress, commCost } = evaluation
    if (smoothness !== null && stress !== null && commCost !== null) {
      axes.push(
        { key: 'smoothness', label: '順調度', value: smoothness },
        { key: 'calm', label: '落ち着き', value: 100 - stress },
        { key: 'commEfficiency', label: 'コミュ効率', value: 100 - commCost }
      )
    }
  }

  const canRerun = evaluation !== null && (evaluation.status === 'ok' || evaluation.status === 'error')

  return (
    <div className="dialog-backdrop evaluation-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="evaluation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evaluation-dialog-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="evaluation-dialog__header">
          <h3 id="evaluation-dialog-title">目的の評価{purposeTitle ? ` — ${purposeTitle}` : ''}</h3>
          <button type="button" onClick={onClose} aria-label="閉じる" autoFocus>
            ✕
          </button>
        </div>
        <div className="evaluation-dialog__body">
          {loadError && (
            <div className="evaluation-dialog__error" role="alert">
              評価の読み込みに失敗しました: {loadError}
            </div>
          )}

          {!loadError && evaluation === null && evaluationEnabled === false && (
            <p className="evaluation-dialog__status" role="status">
              評価は現在無効です。この目的では評価は実行されませんでした（設定で有効にすると、次回以降の目的完了時から評価が実行されます）。
            </p>
          )}

          {!loadError && evaluation === null && evaluationEnabled !== false && (
            <p className="evaluation-dialog__hint">読み込み中…</p>
          )}

          {evaluation?.status === 'pending' && (
            <p className="evaluation-dialog__status" role="status">
              評価を実行しています…（完了までしばらくお待ちください。この画面を閉じても評価は継続します）
            </p>
          )}

          {evaluation?.status === 'skipped' && (
            <p className="evaluation-dialog__status" role="status">
              この目的では評価の対象となる発言が見つからなかったため、評価はスキップされました。
            </p>
          )}

          {evaluation?.status === 'error' && (
            <div className="evaluation-dialog__error" role="alert">
              評価に失敗しました: {evaluation.lastError ?? '(原因不明)'}
            </div>
          )}

          {evaluation?.status === 'ok' && (
            <>
              <div className="evaluation-dialog__chart">
                <RadarChart axes={axes} />
              </div>
              <p className="evaluation-dialog__raw-scores">
                （生データ）順調度: {evaluation.smoothness} / ストレス度: {evaluation.stress}
                （高いほど悪い）/ コミュニケーションコスト: {evaluation.commCost}（高いほど悪い）
              </p>
              <div className="evaluation-dialog__summary">
                <h4>総評</h4>
                <p>{evaluation.summary && evaluation.summary.length > 0 ? evaluation.summary : '(総評なし)'}</p>
              </div>
              <div className="evaluation-dialog__suggestions">
                <h4>改善案</h4>
                {evaluation.suggestions.length === 0 ? (
                  <p className="evaluation-dialog__hint">改善案なし</p>
                ) : (
                  <ul>
                    {evaluation.suggestions.map((s, i) => (
                      <li key={i}>
                        <span className={`evaluation-dialog__suggestion-badge evaluation-dialog__suggestion-badge--${s.category}`}>
                          {CATEGORY_LABEL[s.category]}
                        </span>
                        {s.text}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {evaluation.reportState === 'written' && (
                <p className="evaluation-dialog__hint">評価レポートを出力先に保存しました。</p>
              )}
              {evaluation.reportState === 'error' && (
                <p className="evaluation-dialog__error" role="alert">
                  評価レポートの出力先への書き出しに失敗しました（評価結果自体は保存されています）。
                </p>
              )}
            </>
          )}

          {canRerun && (
            <div className="evaluation-dialog__actions">
              <button type="button" onClick={() => void handleRerun()} disabled={rerunning}>
                再評価する
              </button>
              {rerunError && (
                <span className="evaluation-dialog__error" role="alert">
                  再評価の開始に失敗しました: {rerunError}
                </span>
              )}
            </div>
          )}

          <p className="evaluation-dialog__disclaimer">
            この評価はLLMによる主観的な単発判定であり、精度は保証されません。傾向は評価ダッシュボードの週次/月次遷移でご確認ください。
          </p>
        </div>
      </div>
    </div>
  )
}
