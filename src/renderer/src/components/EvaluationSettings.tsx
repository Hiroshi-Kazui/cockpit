// Settings dialog for the M9 evaluation pipeline (R-5, ADR-0010 D-2/D-5): enable/disable, model, and the
// report output-destination folder (probe-validated on set, same D-5 pattern ArchiveOutputSettings.tsx
// already established for the archive-output mirror root -- an entirely independent setting/root from
// that one). Rendered as an overlay sibling of PaneGrid in App.tsx, same mounting convention.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { AppSettings } from '@shared/ipc'

interface EvaluationSettingsProps {
  onClose: () => void
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'

export function EvaluationSettings({ onClose }: EvaluationSettingsProps): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [modelInput, setModelInput] = useState('')
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    window.cockpit.appSettings
      .get()
      .then((result) => {
        setSettings(result)
        setModelInput(result.evaluationModel)
      })
      .catch((err: unknown) => setLoadError(describeError(err)))
  }, [])

  async function handleToggleEnabled(): Promise<void> {
    if (!settings) return
    setActionError(null)
    const next = !settings.evaluationEnabled
    setSettings({ ...settings, evaluationEnabled: next })
    try {
      await window.cockpit.evaluation.setEnabled({ enabled: next })
    } catch (err) {
      setActionError(describeError(err))
      setSettings((prev) => (prev ? { ...prev, evaluationEnabled: !next } : prev))
    }
  }

  async function handleModelBlur(): Promise<void> {
    const trimmed = modelInput.trim()
    if (trimmed.length === 0 || trimmed === settings?.evaluationModel) return
    setActionError(null)
    try {
      await window.cockpit.evaluation.setModel({ model: trimmed })
      setSettings((prev) => (prev ? { ...prev, evaluationModel: trimmed } : prev))
    } catch (err) {
      setActionError(describeError(err))
    }
  }

  async function handleChooseFolder(): Promise<void> {
    setActionError(null)
    try {
      const chosen = await window.cockpit.evaluation.chooseOutputRootFolder()
      if (chosen.canceled || chosen.path === null) return
      setBusy(true)
      const result = await window.cockpit.evaluation.setOutputRoot({ root: chosen.path })
      if (!result.ok) {
        setActionError(result.reason)
      } else {
        setSettings((prev) => (prev ? { ...prev, evaluationOutputRoot: chosen.path } : prev))
      }
    } catch (err) {
      setActionError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleClear(): Promise<void> {
    setActionError(null)
    setBusy(true)
    try {
      const result = await window.cockpit.evaluation.setOutputRoot({ root: null })
      if (!result.ok) {
        setActionError(result.reason)
      } else {
        setSettings((prev) => (prev ? { ...prev, evaluationOutputRoot: null } : prev))
      }
    } catch (err) {
      setActionError(describeError(err))
    } finally {
      setBusy(false)
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

  return (
    <div className="dialog-backdrop evaluation-settings-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="evaluation-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evaluation-settings-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="evaluation-settings__header">
          <h3 id="evaluation-settings-title">評価の設定</h3>
          <button type="button" onClick={onClose} aria-label="閉じる" autoFocus>
            ✕
          </button>
        </div>
        <div className="evaluation-settings__body">
          {loadError && (
            <div className="evaluation-settings__error" role="alert">
              設定の読み込みに失敗しました: {loadError}
            </div>
          )}
          {settings && (
            <>
              <label className="evaluation-settings__row">
                <input
                  type="checkbox"
                  checked={settings.evaluationEnabled}
                  onChange={() => void handleToggleEnabled()}
                />
                目的完了時の評価を有効にする
              </label>
              <label className="evaluation-settings__row" htmlFor="evaluation-model-input">
                評価に使うモデル
                <input
                  id="evaluation-model-input"
                  value={modelInput}
                  onChange={(e) => setModelInput(e.target.value)}
                  onBlur={() => void handleModelBlur()}
                />
              </label>
              <div className="evaluation-settings__current">
                <span>評価レポートの出力先:</span>
                <span>{settings.evaluationOutputRoot ?? '未設定（アプリ内表示のみ）'}</span>
              </div>
              <div className="evaluation-settings__actions">
                <button type="button" onClick={() => void handleChooseFolder()} disabled={busy}>
                  フォルダを選択…
                </button>
                <button
                  type="button"
                  onClick={() => void handleClear()}
                  disabled={busy || !settings.evaluationOutputRoot}
                >
                  解除
                </button>
              </div>
              <p className="evaluation-settings__hint">
                「解除」は設定を消すだけです。これまでに出力されたレポートはそのまま残ります（削除はされません）。
              </p>
            </>
          )}
          {actionError && (
            <div className="evaluation-settings__error" role="alert">
              {actionError}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
