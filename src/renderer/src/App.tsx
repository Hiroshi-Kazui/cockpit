// Root renderer component: layout state, pane settings, purpose lifecycle state (M4, spec §4.6),
// claude-resolution status banner, status bar.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PANE_INDICES,
  type ClaudeResolveStatus,
  type PaneIndex,
  type PaneSetting,
  type PurposeSummary
} from '@shared/ipc'
import { visiblePanesForLayout, type LayoutMode } from '@shared/layout'
import { ArchiveOutputSettings } from './components/ArchiveOutputSettings'
import { LayoutSwitcher } from './components/LayoutSwitcher'
import { PaneGrid } from './components/PaneGrid'
import { SessionBrowser } from './components/SessionBrowser'
import { StatusBar } from './components/StatusBar'
import { useMirrorStatus } from './hooks/useMirrorStatus'
import { usePaneFocusShortcuts } from './hooks/usePaneFocusShortcuts'
import { useRateLimitsDisplay } from './hooks/useRateLimitsDisplay'
import { useUsageSettings } from './hooks/useUsageSettings'

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function emptyPaneSettings(): PaneSetting[] {
  return PANE_INDICES.map((pane) => ({ pane, defaultCwd: null }))
}

function emptyPurposesByPane(): Record<PaneIndex, PurposeSummary | null> {
  const map = {} as Record<PaneIndex, PurposeSummary | null>
  for (const pane of PANE_INDICES) map[pane] = null
  return map
}

export function App(): React.JSX.Element {
  const [layout, setLayout] = useState<LayoutMode>('single')
  const [paneSettings, setPaneSettings] = useState<PaneSetting[]>(emptyPaneSettings())
  const [purposesByPane, setPurposesByPane] =
    useState<Record<PaneIndex, PurposeSummary | null>>(emptyPurposesByPane())
  const [claudeStatus, setClaudeStatus] = useState<ClaudeResolveStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // M5: rendered as an overlay sibling of PaneGrid below (not nested inside it) -- opening/closing this
  // never mounts/unmounts a Pane, so a running pty's terminal state is untouched (AC "レイアウト切替時に
  // ペイン内容が壊れない" extends to this dialog: it's the same "PaneGrid always stays mounted" principle).
  const [showSessionBrowser, setShowSessionBrowser] = useState(false)
  // M5 (usability FIX): the "過去セッション" button that opens SessionBrowser is the definitive focus
  // target to restore on close -- captured here (the opener), not inferred inside SessionBrowser from
  // `document.activeElement` at mount time, because by the time SessionBrowser's own effects run, its
  // search input has already claimed focus via `autoFocus`, making any post-mount capture a no-op once
  // the dialog unmounts (the previously-focused element it would have found is itself gone).
  const archiveButtonRef = useRef<HTMLButtonElement | null>(null)
  const closeSessionBrowser = useCallback((): void => {
    setShowSessionBrowser(false)
    archiveButtonRef.current?.focus()
  }, [])
  // M6 (spec §4.4.1): same overlay-sibling-of-PaneGrid / focus-restore-to-opener convention as
  // showSessionBrowser above. M7 followup (UX: フォーカス復帰先の不一致): this dialog can be opened from
  // *either* the header button or StatusBar's mirror indicator -- `archiveOutputSettingsOpener` records
  // which one, so closing restores focus to whichever element actually opened it, not always the header
  // button.
  const [showArchiveOutputSettings, setShowArchiveOutputSettings] = useState(false)
  const [archiveOutputSettingsOpener, setArchiveOutputSettingsOpener] = useState<
    'header' | 'statusBar'
  >('header')
  const archiveOutputSettingsButtonRef = useRef<HTMLButtonElement | null>(null)
  const mirrorIndicatorButtonRef = useRef<HTMLButtonElement | null>(null)
  const openArchiveOutputSettingsFromHeader = useCallback((): void => {
    setArchiveOutputSettingsOpener('header')
    setShowArchiveOutputSettings(true)
  }, [])
  const openArchiveOutputSettingsFromStatusBar = useCallback((): void => {
    setArchiveOutputSettingsOpener('statusBar')
    setShowArchiveOutputSettings(true)
  }, [])
  const closeArchiveOutputSettings = useCallback((): void => {
    setShowArchiveOutputSettings(false)
    if (archiveOutputSettingsOpener === 'statusBar') {
      mirrorIndicatorButtonRef.current?.focus()
    } else {
      archiveOutputSettingsButtonRef.current?.focus()
    }
  }, [archiveOutputSettingsOpener])
  const rateLimitsDisplay = useRateLimitsDisplay()
  const usageSettings = useUsageSettings()
  const mirrorStatus = useMirrorStatus()

  // M5 (AC "キーボードでのペイン間フォーカス移動"): registry of each mounted pane's terminal-focus
  // callback, populated by Pane.tsx via onRegisterFocus and consumed by usePaneFocusShortcuts' Ctrl+1..4
  // handler below. A ref (not state) since registering/unregistering a pane's focus fn should never itself
  // trigger a re-render -- only usePaneFocusShortcuts' own keydown listener reads it, on demand.
  const focusFnsRef = useRef<Partial<Record<PaneIndex, () => void>>>({})
  const registerPaneFocus = useCallback((pane: PaneIndex, focusFn: (() => void) | null): void => {
    if (focusFn) {
      focusFnsRef.current[pane] = focusFn
    } else {
      delete focusFnsRef.current[pane]
    }
  }, [])
  const getPaneFocus = useCallback((pane: PaneIndex) => focusFnsRef.current[pane], [])

  useEffect(() => {
    window.cockpit.paneSettings
      .getAll()
      .then(setPaneSettings)
      .catch((err: unknown) => setLoadError(describeError(err)))
    window.cockpit.claude
      .resolveStatus()
      .then(setClaudeStatus)
      .catch((err: unknown) => setLoadError(describeError(err)))
    // TD-7 restart recovery: only *active* purposes are restored on startup (a pane with only
    // completed history starts back at the plain "新規セッション" state, spec §4.6).
    window.cockpit.purpose
      .getActiveForAllPanes()
      .then((purposes) => {
        setPurposesByPane((prev) => {
          const next = { ...prev }
          for (const purpose of purposes) next[purpose.pane] = purpose
          return next
        })
      })
      .catch((err: unknown) => setLoadError(describeError(err)))
  }, [])

  // Keeps purposesByPane live across the whole app lifetime (creation, async title backfill,
  // completion) regardless of which pane's dialog/complete action triggered the change -- the pushed
  // summary always carries its own `pane`, and is kept (not discarded) even once completed so a
  // running session's header can still show its title/purpose text (see Pane.tsx's headerTitle).
  useEffect(() => {
    const unsubscribe = window.cockpit.purpose.onUpdated((purpose) => {
      setPurposesByPane((prev) => ({ ...prev, [purpose.pane]: purpose }))
    })
    return unsubscribe
  }, [])

  function handleCwdChange(pane: PaneIndex, cwd: string): void {
    setPaneSettings((prev) => prev.map((s) => (s.pane === pane ? { ...s, defaultCwd: cwd } : s)))
  }

  // M5: memoized so usePaneFocusShortcuts (which depends on this Set's identity) doesn't re-subscribe its
  // window keydown listener on every unrelated App re-render -- only when `layout` actually changes.
  const visiblePanes = useMemo(() => new Set(visiblePanesForLayout(layout)), [layout])

  // M5/M6: disabled while any `aria-modal="true"` overlay is open (read-only session browser, or the M6
  // archive-output settings dialog) -- see usePaneFocusShortcuts' `enabled` doc comment -- so a global
  // Ctrl+1..4 focus jump can't bypass the modal and land keystrokes on a live pty behind it.
  usePaneFocusShortcuts(
    visiblePanes,
    getPaneFocus,
    !showSessionBrowser && !showArchiveOutputSettings
  )

  return (
    <div className="app">
      <header className="app-header">
        <h1>cockpit</h1>
        <LayoutSwitcher value={layout} onChange={setLayout} />
        <button
          type="button"
          ref={archiveButtonRef}
          className="app-header__archive-button"
          onClick={() => setShowSessionBrowser(true)}
        >
          過去セッション
        </button>
        <button
          type="button"
          ref={archiveOutputSettingsButtonRef}
          className="app-header__archive-button"
          onClick={openArchiveOutputSettingsFromHeader}
        >
          アーカイブ出力先
        </button>
      </header>
      {loadError && (
        <div className="banner banner--error" role="alert">
          初期化に失敗しました: {loadError}
        </div>
      )}
      {claudeStatus && !claudeStatus.resolved && (
        <div className="banner banner--error" role="alert">
          claude CLI が見つかりません: {claudeStatus.reason}
        </div>
      )}
      <PaneGrid
        layout={layout}
        paneSettings={paneSettings}
        visiblePanes={visiblePanes}
        onCwdChange={handleCwdChange}
        claudeResolved={claudeStatus?.resolved ?? true}
        purposesByPane={purposesByPane}
        onRegisterFocus={registerPaneFocus}
      />
      <StatusBar
        display={rateLimitsDisplay}
        settings={usageSettings.settings}
        settingsError={usageSettings.error}
        onSettingsChange={(next) => void usageSettings.update(next)}
        mirrorStatus={mirrorStatus}
        onOpenArchiveOutputSettings={openArchiveOutputSettingsFromStatusBar}
        mirrorIndicatorButtonRef={mirrorIndicatorButtonRef}
      />
      {/* M5: sibling of PaneGrid, not nested inside it -- see showSessionBrowser's doc comment above. */}
      {showSessionBrowser && <SessionBrowser onClose={closeSessionBrowser} />}
      {/* M6: same sibling-of-PaneGrid convention -- see showArchiveOutputSettings's doc comment above.
          M7 followup (structure: useMirrorStatus 二重購読): mirrorStatus is App's single subscription
          (useMirrorStatus above), passed down as a prop rather than ArchiveOutputSettings subscribing to
          its own second copy. */}
      {showArchiveOutputSettings && (
        <ArchiveOutputSettings mirrorStatus={mirrorStatus} onClose={closeArchiveOutputSettings} />
      )}
    </div>
  )
}
