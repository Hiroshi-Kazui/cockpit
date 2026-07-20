// Settings dialog for the M6 archive-output mirror (spec §4.4.1, ADR-0008): shows/changes/clears the
// configured output root, per-session mirror sync state (synced/pending/error), and an explicit backfill
// action. Rendered as an overlay sibling of PaneGrid in App.tsx (never nested inside it), the same
// mounting convention SessionBrowser.tsx already established -- opening/closing this never mounts/
// unmounts a Pane, so a running pty's terminal state is untouched.
//
// D-5 "silent failure 禁止": every failure path here (probe/validation rejection, backfill per-session
// error) is surfaced as visible text, never swallowed. This dialog itself is opened on-demand (not shown
// automatically), so it is a *modal* detail view; the always-visible, non-modal indicator lives in
// StatusBar.tsx instead (spec §4.4.1 "同期状態の可視化" + usability note: mirror errors must not block
// claude's dialogue, so they never appear as a blocking dialog by themselves).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { BackfillProgressEvent, MirrorState } from '@shared/ipc'
import { useMirrorStatus } from '../hooks/useMirrorStatus'

interface ArchiveOutputSettingsProps {
  onClose: () => void
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const STATE_LABELS: Record<MirrorState, string> = {
  synced: '同期済み',
  pending: '保留',
  error: 'エラー'
}

// Same Tab-trap convention as SessionBrowser.tsx's FOCUSABLE_SELECTOR (kept independent per-file rather
// than shared, matching that file's own "keyed on generic HTML semantics, not CSS class names" rationale).
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), [href], select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

export function ArchiveOutputSettings({ onClose }: ArchiveOutputSettingsProps): React.JSX.Element {
  const mirrorStatus = useMirrorStatus()
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [backfillProgress, setBackfillProgress] = useState<BackfillProgressEvent | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const unsubscribe = window.cockpit.archive.onBackfillProgress(setBackfillProgress)
    return unsubscribe
  }, [])

  // Disabling the button the user just clicked (via `busy`) drops it from the tab order, which browsers
  // resolve by moving focus to <body> -- outside this dialog, silently breaking both the Tab-trap above
  // and Escape-to-close (its keydown handler only fires while focus bubbles up from *inside* the dialog).
  // Called from every action's `finally` block once `busy` flips back to false (buttons are re-enabled
  // synchronously in the same tick, so this runs after they're focusable again).
  function restoreFocusIfEscaped(): void {
    const container = dialogRef.current
    if (!container) return
    if (document.activeElement instanceof Node && container.contains(document.activeElement)) return
    container.focus()
  }

  async function handleChooseFolder(): Promise<void> {
    setActionError(null)
    try {
      const chosen = await window.cockpit.archive.chooseOutputRootFolder()
      if (chosen.canceled || chosen.path === null) return
      setBusy(true)
      const result = await window.cockpit.archive.setOutputRoot({ root: chosen.path })
      if (!result.ok) setActionError(result.reason)
    } catch (err) {
      setActionError(describeError(err))
    } finally {
      setBusy(false)
      restoreFocusIfEscaped()
    }
  }

  async function handleClear(): Promise<void> {
    setActionError(null)
    setBusy(true)
    try {
      const result = await window.cockpit.archive.setOutputRoot({ root: null })
      if (!result.ok) setActionError(result.reason)
    } catch (err) {
      setActionError(describeError(err))
    } finally {
      setBusy(false)
      restoreFocusIfEscaped()
    }
  }

  async function handleBackfill(): Promise<void> {
    setActionError(null)
    setBusy(true)
    setBackfillProgress(null)
    try {
      await window.cockpit.archive.startBackfill()
    } catch (err) {
      setActionError(describeError(err))
    } finally {
      setBusy(false)
      restoreFocusIfEscaped()
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
    const focusable = getFocusableElements(container)
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (e.shiftKey) {
      if (active === first || !(active instanceof Node) || !container.contains(active)) {
        e.preventDefault()
        last.focus()
      }
    } else {
      if (active === last || !(active instanceof Node) || !container.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  const outputRoot = mirrorStatus?.outputRoot ?? null

  return (
    <div
      className="dialog-backdrop archive-output-settings-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="archive-output-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-output-settings-title"
        // Not a natural Tab stop (tabIndex={-1}) -- only ever focused programmatically, by
        // restoreFocusIfEscaped above, as a fallback container to land on if the element the user was
        // interacting with got disabled out from under them.
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="archive-output-settings__header">
          <h3 id="archive-output-settings-title">アーカイブ出力先</h3>
          <button type="button" onClick={onClose} aria-label="閉じる" autoFocus>
            ✕
          </button>
        </div>
        <div className="archive-output-settings__body">
          <p className="archive-output-settings__hint">
            アーカイブの一次保存先（アプリ管理領域）は変更できません。ここで設定した出力先には、
            スプールの追記差分が非同期でミラーされます。クラウド同期フォルダ（Google Drive for
            Desktop・OneDrive・Dropbox 等）を指定できます。
          </p>
          <div className="archive-output-settings__current">
            <span className="archive-output-settings__current-label">現在の出力先:</span>
            <span className="archive-output-settings__current-value">{outputRoot ?? '未設定'}</span>
          </div>
          <div className="archive-output-settings__actions">
            <button type="button" onClick={() => void handleChooseFolder()} disabled={busy}>
              フォルダを選択…
            </button>
            <button type="button" onClick={() => void handleClear()} disabled={busy || !outputRoot}>
              解除
            </button>
            <button
              type="button"
              onClick={() => void handleBackfill()}
              disabled={busy || !outputRoot}
            >
              バックフィルを実行
            </button>
          </div>
          {actionError && (
            <div className="archive-output-settings__error" role="alert">
              {actionError}
            </div>
          )}
          {backfillProgress && (
            <div className="archive-output-settings__progress" role="status">
              {backfillProgress.done
                ? `バックフィル完了: ${backfillProgress.processedSessions}/${backfillProgress.totalSessions} 件（失敗 ${backfillProgress.failedSessions} 件）`
                : `バックフィル中: ${backfillProgress.processedSessions}/${backfillProgress.totalSessions} 件`}
            </div>
          )}
          <div className="archive-output-settings__status">
            <h4>ミラー同期状態</h4>
            {!outputRoot && (
              <p className="archive-output-settings__hint">
                出力先が未設定のため、ミラーは動作していません。
              </p>
            )}
            {outputRoot && mirrorStatus && mirrorStatus.entries.length === 0 && (
              <p className="archive-output-settings__hint">
                まだ同期対象のセッションがありません。
              </p>
            )}
            {outputRoot && mirrorStatus && mirrorStatus.entries.length > 0 && (
              <ul className="archive-output-settings__list">
                {mirrorStatus.entries.map((entry) => (
                  <li key={entry.sessionId} className="archive-output-settings__list-item">
                    <span
                      className={`archive-output-settings__badge archive-output-settings__badge--${entry.state}`}
                    >
                      {STATE_LABELS[entry.state]}
                    </span>
                    <span className="archive-output-settings__session-id">{entry.sessionId}</span>
                    {entry.state === 'error' && entry.lastError && (
                      <span className="archive-output-settings__list-error" role="alert">
                        {entry.lastError}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
