// Read-only past-session browser (M5, spec §4.4): search the SQLite session index, select a session, and
// view its archived transcript. Rendered as an overlay *sibling* of PaneGrid in App.tsx (never nested
// inside it), so opening/closing this never mounts/unmounts a single Pane -- a running pty's terminal
// state is untouched (AC "レイアウト切替時にペイン内容が壊れない" extends to this dialog too).
//
// Read-only by construction: there is no button, form, or IPC call anywhere in this component that edits
// or deletes anything (AC "閲覧は読み取り専用...アーカイブへの編集・削除UIが存在しない") -- it only ever
// calls window.cockpit.archive.listSessions/readSession, both of which are main-side read-only handlers
// (see main/ipc/handlers.ts).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ArchiveSessionListItem, ArchiveTranscriptTurn } from '@shared/ipc'

interface SessionBrowserProps {
  onClose: () => void
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

// M5 (architect note): the Tab trap's focusable-element collection below is intentionally keyed on generic
// HTML semantics (tag names + the `tabindex` attribute), never on this component's own CSS class names, so
// a class rename in the markup can't silently break it. This is unlike the arrow-key list navigation (see
// itemRefs below), which used to depend on a hardcoded `.session-browser__item` selector until this fix.
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), [href], select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

// Debounces the search-text -> IPC query so every keystroke doesn't fire its own round-trip.
const SEARCH_DEBOUNCE_MS = 200

export function SessionBrowser({ onClose }: SessionBrowserProps): React.JSX.Element {
  const [searchText, setSearchText] = useState('')
  const [sessions, setSessions] = useState<ArchiveSessionListItem[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [turns, setTurns] = useState<ArchiveTranscriptTurn[] | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  // M5 FIX (deferred item 2): main-side reads cap turns at MAX_DISPLAY_TURNS (archiveReader.ts) and
  // report how many older turns were dropped -- surfaced here rather than silently showing a partial
  // transcript (silent truncation is prohibited).
  const [omittedCount, setOmittedCount] = useState(0)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  // M5 (architect FIX): keyed by session id (not array index) so ArrowUp/Down navigation in
  // handleListKeyDown below can walk the currently-rendered list in render order without depending on the
  // `.session-browser__item` CSS class string via querySelectorAll -- a rename of that class would
  // silently break arrow-key nav otherwise. Entries are added/removed by each item button's ref callback.
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  function registerItemRef(id: string, el: HTMLButtonElement | null): void {
    if (el) {
      itemRefs.current.set(id, el)
    } else {
      itemRefs.current.delete(id)
    }
  }

  // M5 (usability FIX): this dialog declares `aria-modal="true"`, which is a promise to assistive tech and
  // keyboard users that focus stays contained within it while open, and returns somewhere sane once it
  // closes. Focus restoration is intentionally NOT done here via `document.activeElement` captured at
  // mount: by the time any effect in this component runs, the search input's `autoFocus` below has already
  // claimed focus, so "whatever was focused at mount" would just be this dialog's own (about-to-unmount)
  // input -- a no-op. Instead the caller (App.tsx) owns a ref to the "過去セッション" button that opened
  // this dialog and explicitly refocuses it inside `onClose`, which every closing path here (Escape,
  // backdrop click, ✕ button) funnels through.
  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      window.cockpit.archive
        .listSessions({ searchText: searchText.trim() })
        .then((result) => {
          if (cancelled) return
          setSessions(result)
          setListError(null)
        })
        .catch((err: unknown) => {
          if (!cancelled) setListError(describeError(err))
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [searchText])

  useEffect(() => {
    if (!selectedId) {
      setTurns(null)
      setDetailError(null)
      setOmittedCount(0)
      return
    }
    let cancelled = false
    setTurns(null)
    setLoadingDetail(true)
    setDetailError(null)
    setOmittedCount(0)
    window.cockpit.archive
      .readSession({ sessionId: selectedId })
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          setTurns(result.turns)
          setOmittedCount(result.truncated ? result.omittedCount : 0)
        } else {
          setTurns(null)
          setDetailError(result.reason)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setDetailError(describeError(err))
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  // M5 (usability FIX): traps Tab/Shift+Tab within the dialog so it can't leak focus out to the panes or
  // status bar behind it, matching its `aria-modal="true"` declaration. Escape calls `onClose`, same as
  // every other closing path here -- the caller (App.tsx) is what refocuses the opener button afterwards
  // (see the comment above `itemRefs`/mount effects), so Escape never "escapes" into the void.
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

  // M5 usability polish: Up/Down arrow keys move focus between session-list items (a common listbox-like
  // convention), without interfering with the Tab trap above -- Tab/Shift+Tab still moves through the
  // dialog's full focus order (search input -> list items -> close button), this only adds a faster path
  // while already focused within the list itself.
  //
  // M5 (architect FIX): walks `sessions` (React state, the source of truth for render order) and looks up
  // each item's live button via the id-keyed ref map above, instead of re-querying the DOM by CSS class.
  function handleListKeyDown(e: KeyboardEvent<HTMLUListElement>): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const buttons = sessions
      .map((s) => itemRefs.current.get(s.id))
      .filter((b): b is HTMLButtonElement => b !== undefined)
    if (buttons.length === 0) return
    e.preventDefault()
    const currentIndex = buttons.findIndex((b) => b === document.activeElement)
    let nextIndex: number
    if (currentIndex === -1) {
      nextIndex = e.key === 'ArrowDown' ? 0 : buttons.length - 1
    } else if (e.key === 'ArrowDown') {
      nextIndex = Math.min(currentIndex + 1, buttons.length - 1)
    } else {
      nextIndex = Math.max(currentIndex - 1, 0)
    }
    buttons[nextIndex].focus()
  }

  return (
    <div className="dialog-backdrop session-browser-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="session-browser"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-browser-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="session-browser__header">
          <h3 id="session-browser-title">過去セッション（閲覧専用）</h3>
          <button type="button" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        <div className="session-browser__body">
          <div className="session-browser__list-pane">
            <input
              type="text"
              aria-label="セッション検索"
              placeholder="目的・タイトル・フォルダで検索"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              autoFocus
            />
            {listError && (
              <div className="session-browser__error" role="alert">
                {listError}
              </div>
            )}
            <ul className="session-browser__list" onKeyDown={handleListKeyDown}>
              {sessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    ref={(el) => registerItemRef(s.id, el)}
                    className={
                      s.id === selectedId
                        ? 'session-browser__item session-browser__item--active'
                        : 'session-browser__item'
                    }
                    aria-pressed={s.id === selectedId}
                    onClick={() => setSelectedId(s.id)}
                  >
                    <span className="session-browser__item-title">
                      {s.title || s.purpose || '(未設定)'}
                    </span>
                    <span className="session-browser__item-meta">
                      Pane {s.pane + 1} ・ {formatDateTime(s.startedAt)}
                      {s.endedAt === null ? ' ・ 実行中' : ''}
                    </span>
                    {s.cwd && (
                      <span className="session-browser__item-cwd" title={s.cwd}>
                        {s.cwd}
                      </span>
                    )}
                  </button>
                </li>
              ))}
              {sessions.length === 0 && !listError && (
                <li className="session-browser__empty">該当するセッションがありません</li>
              )}
            </ul>
          </div>
          <div className="session-browser__detail-pane">
            {!selectedId && (
              <div className="session-browser__hint">セッションを選択してください</div>
            )}
            {loadingDetail && <div className="session-browser__hint">読み込み中…</div>}
            {detailError && (
              <div className="session-browser__error" role="alert">
                記録の読み込みに失敗しました: {detailError}
              </div>
            )}
            {turns && omittedCount > 0 && (
              <div className="session-browser__notice" role="status">
                古い {omittedCount} 件を省略して表示しています（最新 {turns.length} 件）
              </div>
            )}
            {turns && (
              <div
                className="session-browser__transcript"
                role="log"
                aria-label="セッションの記録（読み取り専用）"
                // M5 (usability FIX): makes the scrollable transcript itself a Tab stop (picked up by
                // FOCUSABLE_SELECTOR's `[tabindex]:not([tabindex="-1"])` clause above, and thus included in
                // the Tab trap's focus order) so keyboard-only users can reach it and scroll with
                // ArrowUp/Down/PageUp/PageDown/Home/End without a mouse.
                tabIndex={0}
              >
                {turns.length === 0 && (
                  <div className="session-browser__hint">記録された発言がありません</div>
                )}
                {turns.map((turn, i) => (
                  <div key={i} className={`session-turn session-turn--${turn.role}`}>
                    <div className="session-turn__role">
                      {turn.role === 'user' ? 'ユーザ' : 'エージェント'}
                    </div>
                    <div className="session-turn__text">{turn.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
