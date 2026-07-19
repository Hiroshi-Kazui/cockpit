// Purpose-input dialog shown when a pane's "新規セッション" button is pressed (spec §4.2 step 1). Pure
// UI: the caller owns actually creating the purpose/spawning the pty (Pane.tsx -> paneLaunch.start).
import { useRef, useState, type KeyboardEvent } from 'react'
import type { PaneIndex } from '@shared/ipc'

interface PurposeDialogProps {
  pane: PaneIndex
  cwd: string
  onCancel: () => void
  onConfirm: (text: string) => void
}

/** Elements the M4 FIX (usability #5) Tab focus-trap cycles between; excludes the read-only cwd
 * display (informational, not an editable input) so Tab only ever visits actionable controls. */
const FOCUSABLE_SELECTOR = 'textarea, button:not(:disabled)'

export function PurposeDialog({
  pane,
  cwd,
  onCancel,
  onConfirm
}: PurposeDialogProps): React.JSX.Element {
  const [text, setText] = useState('')
  const trimmed = text.trim()
  const dialogRef = useRef<HTMLDivElement>(null)

  // spec §4.2 "目的テキストの入力は任意（空のまま開始できる）": an empty purpose is a valid, deliberate
  // choice (the app then decides the purpose from the session's first non-command chat turn instead), so
  // confirm is always allowed -- there is no length gate here.
  function handleConfirm(): void {
    onConfirm(trimmed)
  }

  // M4 FIX (usability #5): Escape cancels, Ctrl/Cmd+Enter confirms from anywhere in the dialog
  // (including the textarea, where a plain Enter must keep inserting a newline), and Tab is trapped
  // inside the dialog so focus never leaks to the pane/app behind this modal overlay.
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
      return
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleConfirm()
      return
    }
    if (e.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
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
    <div className="dialog-backdrop" role="presentation" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="purpose-dialog-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <h3 id="purpose-dialog-title">新規セッション — ペイン {pane + 1} の目的</h3>
        <div className="dialog-body">
          <label htmlFor="purpose-dialog-text">
            このセッションで達成したいこと（完了操作するまで継続します・空でも開始できます）
            <span className="dialog-body__hint">Ctrl(Cmd)+Enter で開始 / Esc でキャンセル</span>
          </label>
          <textarea
            id="purpose-dialog-text"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="例: READMEにセットアップ手順を追記して（空のまま開始すると、最初の発言から目的を自動的に決定します）"
          />
          <label htmlFor="purpose-dialog-cwd">作業フォルダ（cwd）</label>
          {/* M4 FIX iter3 (usability #2): tabIndex=-1 keeps this read-only display out of the native Tab
              order too, so it can never become a stop the Tab-trap logic above has to route around --
              matching the FOCUSABLE_SELECTOR comment's stated intent that only actionable controls are
              visited. */}
          <input id="purpose-dialog-cwd" value={cwd} readOnly tabIndex={-1} />
          <div className="dialog-row">
            <button type="button" onClick={onCancel}>
              キャンセル
            </button>
            <button type="button" className="dialog-row__primary" onClick={handleConfirm}>
              開始 ▶
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
