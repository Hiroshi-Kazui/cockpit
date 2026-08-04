// Single pane: header (folder picker, purpose lifecycle, start/stop, error banner, context gauge) +
// xterm.js terminal surface. The purpose-driven launch flow (dialog / 再開 / 完了, spec §4.2/§4.6,
// TD-7) lives here; actual purpose persistence + pty launch orchestration is all Main-side
// (purposeCoordinator.ts) -- this component only decides *which* IPC action to call and renders state
// pushed down from App.tsx (`purpose` prop, kept in sync via cockpit:purpose:updated).
import { useEffect, useState } from 'react'
import type { PaneIndex, PurposeSummary, RepoSyncOutcome } from '@shared/ipc'
import { describeRepoSyncOutcome } from '@shared/gitSync'
import { usePtyPane } from '../hooks/usePtyPane'
import { useSessionTelemetry } from '../hooks/useSessionTelemetry'
import { useArchiveWarning } from '../hooks/useArchiveWarning'
import { usePaneContextUsage } from '../hooks/usePaneContextUsage'
import { ContextGauge } from './ContextGauge'
import { PurposeDialog } from './PurposeDialog'
import { EvaluationDialog } from './EvaluationDialog'

interface PaneProps {
  paneIndex: PaneIndex
  defaultCwd: string | null
  onCwdChange: (pane: PaneIndex, cwd: string) => void
  claudeResolved: boolean
  /** Most recently known purpose for this pane, of either status (spec §4.6, TD-7). Null means no
   * purpose has ever been created for this pane, or none is known yet. */
  purpose: PurposeSummary | null
  /** M5 (AC "キーボードでのペイン間フォーカス移動"): registers/unregisters this pane's terminal-focus
   * callback with the App-level shortcut registry (usePaneFocusShortcuts, wired in App.tsx). Passed
   * `null` to unregister the entry entirely on unmount. */
  onRegisterFocus: (pane: PaneIndex, focusFn: (() => void) | null) => void
  /** M9 FIX (iter1 major): tells App.tsx whether this pane's EvaluationDialog is currently open, so the
   * global Ctrl+1..4 pane-focus shortcut (usePaneFocusShortcuts) can be disabled while it is -- the same
   * "modal is open, don't let a global shortcut reach a pty behind it" treatment SessionBrowser/
   * ArchiveOutputSettings/EvaluationDashboard/EvaluationSettings already get in App.tsx, which this
   * pane-local dialog was previously missing from. */
  onEvaluationDialogVisibilityChange: (pane: PaneIndex, visible: boolean) => void
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function Pane({
  paneIndex,
  defaultCwd,
  onCwdChange,
  claudeResolved,
  purpose,
  onRegisterFocus,
  onEvaluationDialogVisibilityChange
}: PaneProps): React.JSX.Element {
  const { containerRef, running, error, start, stop, focus } = usePtyPane(paneIndex)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [purposeError, setPurposeError] = useState<string | null>(null)
  const [showDialog, setShowDialog] = useState(false)
  // M9 (ADR-0010 R-2): opened automatically right after a successful "完了" action *when evaluation is
  // enabled* (handleComplete re-checks app_settings.evaluation_enabled before setting this -- see its own
  // comment), and always re-openable afterward via the "評価を見る" button for any completed purpose
  // regardless of the current toggle state (a purpose evaluated while enabled stays viewable after being
  // turned off; EvaluationDialog itself renders an explicit "無効" state instead of an eternal spinner
  // when there is no evaluation to show and the toggle is off).
  const [showEvaluation, setShowEvaluation] = useState(false)
  // M11 (spec §4.2 addendum, ADR-0013): `launchKind` covers the whole paneLaunch.start/resume round-trip,
  // which can now take up to ~30s while a git pull runs (R-7) -- disables the launch affordances for that
  // whole window so a second click cannot start a second launch concurrently ("ボタン連打で二重起動でき
  // ない"). FIX M7 (review iter1): distinguishes *which* launch is in flight ('start' vs 'resume') so the
  // in-progress text never claims a git sync is happening during "再開", which never runs one (R-1/D-1).
  // `repoSyncNotice` is the git-sync outcome from the most recent paneLaunch.start (never set by "再開") --
  // rendered as a pane-local notification row below (never a modal; blocked-dirty/blocked-busy already got
  // their own native alert main-side, D-9). `repoSyncExpanded`/`launchError` are FIX M8/B3 (below).
  const [launchKind, setLaunchKind] = useState<'start' | 'resume' | null>(null)
  const [repoSyncNotice, setRepoSyncNotice] = useState<RepoSyncOutcome | null>(null)
  const [repoSyncExpanded, setRepoSyncExpanded] = useState(false)
  // FIX B3 (review iter1): paneLaunch.start can resolve with `pid: null` (git sync ran, but the spawn
  // itself then failed) instead of throwing -- usePtyPane.start no longer treats that as an exception, so
  // this component must surface `result.message` itself instead of relying on usePtyPane's own `error`.
  const [launchError, setLaunchError] = useState<string | null>(null)
  const session = useSessionTelemetry(paneIndex)
  const archiveWarning = useArchiveWarning(paneIndex)
  const contextUsage = usePaneContextUsage(paneIndex, running)

  // M5 (AC "キーボードでのペイン間フォーカス移動"): registers this pane's terminal-focus callback with
  // the App-level registry as soon as the terminal has mounted (usePtyPane's `focus` is stable across
  // this pane's own re-renders, only `paneIndex` in its deps), and unregisters on unmount.
  useEffect(() => {
    onRegisterFocus(paneIndex, focus)
    return () => onRegisterFocus(paneIndex, null)
  }, [paneIndex, focus, onRegisterFocus])

  // M9 FIX (iter1 major): defensive unmount cleanup mirroring the focus registration above -- panes are
  // always kept mounted for the app's lifetime in practice (PaneGrid.tsx), but this guarantees App.tsx's
  // evaluationDialogOpenPanes set can never keep a stale "open" entry for a pane that no longer exists.
  useEffect(() => {
    return () => onEvaluationDialogVisibilityChange(paneIndex, false)
  }, [paneIndex, onEvaluationDialogVisibilityChange])

  function openEvaluationDialog(): void {
    setShowEvaluation(true)
    onEvaluationDialogVisibilityChange(paneIndex, true)
  }

  function closeEvaluationDialog(): void {
    setShowEvaluation(false)
    onEvaluationDialogVisibilityChange(paneIndex, false)
  }

  const isActivePurpose = purpose?.status === 'active'
  // M4 FIX (usability #2/#3): an active purpose whose text is still undecided (spec §4.2 "目的が空で
  // 開始した場合") -- distinct from title===null/"still generating" below, this state has no text to
  // generate *from* yet. Used both while running (header hint, #2) and while stopped (resume-overlay
  // wording, #3), so it is computed once here regardless of `running`.
  const isActivePurposeTextUndecided =
    purpose !== null && purpose.status === 'active' && purpose.text.length === 0
  const isAwaitingPurposeDecision = running && isActivePurposeTextUndecided

  async function handleChooseFolder(): Promise<void> {
    setFolderError(null)
    // TD-7: --continue assumes a fixed cwd for the purpose's lifetime -- warn before letting the user
    // change the folder out from under an active purpose.
    if (isActivePurpose) {
      try {
        const { confirmed } = await window.cockpit.paneSettings.confirmActivePurposeCwdChange()
        if (!confirmed) return
      } catch (err) {
        setFolderError(describeError(err))
        return
      }
    }
    try {
      const result = await window.cockpit.paneSettings.chooseFolder()
      if (result.canceled || !result.path) return
      await window.cockpit.paneSettings.setCwd({ pane: paneIndex, cwd: result.path })
      onCwdChange(paneIndex, result.path)
    } catch (err) {
      setFolderError(describeError(err))
    }
  }

  function handleOpenDialog(): void {
    if (!defaultCwd) {
      setFolderError('先にデフォルトフォルダを設定してください')
      return
    }
    setFolderError(null)
    setShowDialog(true)
  }

  async function handleConfirmDialog(text: string): Promise<void> {
    setShowDialog(false)
    const cwd = defaultCwd
    if (!cwd) {
      setFolderError('先にデフォルトフォルダを設定してください')
      return
    }
    setRepoSyncNotice(null)
    setRepoSyncExpanded(false)
    setLaunchError(null)
    setLaunchKind('start')
    try {
      const result = await start(() =>
        window.cockpit.paneLaunch.start({ pane: paneIndex, cwd, purposeText: text })
      )
      if (result) {
        setRepoSyncNotice(result.repoSync)
        // FIX B3 (review iter1): a resolved pid:null result means the git sync ran (repoSync above is
        // already set) but the spawn itself failed -- surface that failure too, distinctly from the
        // git-sync notice.
        if (result.pid === null) setLaunchError(result.message)
      }
    } finally {
      setLaunchKind(null)
    }
  }

  async function handleResume(): Promise<void> {
    if (!defaultCwd) {
      setFolderError('先にデフォルトフォルダを設定してください')
      return
    }
    setFolderError(null)
    // "再開" never runs the git sync (ADR-0013/D-1) -- clear any stale notice from a previous launch so
    // it isn't misread as describing this resume. FIX minor-C (review iter2): also clear a stale
    // launchError from a previous failed "＋ 新規セッション" attempt, which otherwise kept showing after
    // a successful "再開".
    setRepoSyncNotice(null)
    setRepoSyncExpanded(false)
    setLaunchError(null)
    setLaunchKind('resume')
    try {
      await start(() => window.cockpit.paneLaunch.resume({ pane: paneIndex, cwd: defaultCwd }))
    } finally {
      setLaunchKind(null)
    }
  }

  async function handleComplete(): Promise<void> {
    if (!purpose) return
    setPurposeError(null)
    try {
      await window.cockpit.purpose.complete({ purposeId: purpose.id })
    } catch (err) {
      setPurposeError(describeError(err))
      return
    }
    // M9 FIX (iter1 blocking): completion triggers evaluation server-side (fire-and-forget, R-1/R-2), but
    // only when the master toggle is on -- evaluationCoordinator.run() returns before creating any row or
    // pushing any update when `evaluation_enabled` is off (D-2), so unconditionally auto-opening here
    // previously left the dialog stuck on "読み込み中…" forever (a regression from M8, which never opened
    // anything on completion). Re-check the live setting right before deciding to open, rather than trust
    // a value fetched/cached earlier in this pane's lifetime, since it can be toggled at any time from the
    // 評価設定 dialog.
    try {
      const settings = await window.cockpit.appSettings.get()
      if (settings.evaluationEnabled) openEvaluationDialog()
    } catch (err) {
      // Completion itself already succeeded above -- a failure here only means we can't safely tell
      // whether to auto-open the dialog, so we don't guess (never silently pretend an evaluation started,
      // CLAUDE.md silent-failure prohibition). The "評価を見る" button remains available afterward.
      console.error('[pane] failed to read evaluation settings after completing purpose', err)
    }
  }

  const displayedError = error ?? folderError ?? purposeError ?? launchError
  // spec §4.2/§4.6: an empty-started purpose (text==='') has no title to generate yet and is displayed
  // as "未設定" until the session's first non-command chat turn decides it (purposeDetectionCoordinator,
  // pushed back down via the same cockpit:purpose:updated channel this component already listens to via
  // App.tsx's `purpose` prop). Once purpose.text is non-empty, title===null instead means generation is
  // merely still in flight (existing M4 behavior, unchanged).
  const headerTitle = purpose
    ? purpose.text.length === 0
      ? '未設定'
      : (purpose.title ?? '(タイトル生成中…)')
    : null

  // FIX M8 (review iter1): pre-computed here (rather than inline in JSX) so the notification row's render
  // branch below stays simple. See its render-site comment for why only the first line shows by default.
  const repoSyncFullText = repoSyncNotice ? describeRepoSyncOutcome(repoSyncNotice) : null
  const repoSyncFirstLine = repoSyncFullText?.split('\n')[0] ?? null
  const repoSyncHasMoreLines = repoSyncFullText?.includes('\n') ?? false
  const repoSyncIsFailed = repoSyncNotice?.kind === 'failed'

  return (
    <div className="pane">
      <div className="pane-header">
        <span className="pane-title">
          {headerTitle ?? `Pane ${paneIndex + 1}`}
          {purpose?.status === 'completed' && (
            <span className="pane-title__badge" title="この目的は完了しています">
              完了済み
            </span>
          )}
        </span>
        <span className="pane-cwd" title={defaultCwd ?? ''}>
          {defaultCwd ?? '(フォルダ未設定)'}
        </span>
        {contextUsage && (
          <ContextGauge usedPercentage={contextUsage.usedPercentage} color={contextUsage.color} />
        )}
        <button type="button" onClick={() => void handleChooseFolder()}>
          フォルダ選択
        </button>
        {isActivePurpose && (
          <button type="button" onClick={() => void handleComplete()} title="この目的を完了にする">
            完了
          </button>
        )}
        {/* M9 (ADR-0010 R-2/R-7): revisit a completed purpose's evaluation (view result / see pending or
            error state / re-run) without needing to complete it again. */}
        {purpose?.status === 'completed' && (
          <button type="button" onClick={openEvaluationDialog} title="この目的の評価を見る">
            評価を見る
          </button>
        )}
        {running ? (
          <button type="button" onClick={() => void stop()}>
            停止
          </button>
        ) : isActivePurpose ? null : (
          <button
            type="button"
            onClick={handleOpenDialog}
            disabled={!claudeResolved || !defaultCwd || launchKind !== null}
            title={claudeResolved ? undefined : 'claude CLI が見つからないため起動できません'}
          >
            ＋ 新規セッション
          </button>
        )}
      </div>
      {/* Every informational row lives inside this one always-present, fixed-height band, and none of them
          is a flex child of .pane any more. Rationale is a correctness one, not cosmetic: ConPTY reprints
          its own view of the screen on every resize, and rows xterm.js has already moved into its
          scrollback are still "on screen" for ConPTY, so *any* change to a running pty's row count makes
          the two disagree about which buffer row is which -- the reported "縦スクロールで表示が崩れ、行頭
          のセルに前の行の文字が残る" artifact. Measured with a real ConPTY + a real xterm.js buffer: with no
          resize the buffer stays byte-identical to the emitted text, while a 3-row change (exactly what
          .pane-purpose / .pane-telemetry / .pane-repo-sync appearing one after another used to cause,
          seconds into every session) corrupts it every single run -- and reordering term.resize/pty.resize
          does not help, because the mismatch is ConPTY's, not a race. These rows appearing and disappearing
          was the only resize cockpit itself caused; keeping the band's height constant removes it. Rows
          beyond the reserved height scroll inside the band (.pane-info) rather than growing it. */}
      <div className="pane-info">
        {/* M11 (R-7): shown for the whole paneLaunch.start round-trip, which can take up to ~30s while a git
          pull runs -- keeps the "＋ 新規セッション" affordance (disabled above) from looking merely
          unresponsive. FIX M7 (review iter1): "再開" gets its own, git-sync-free wording (R-1/D-1: "再開"
          never runs the git sync at all). */}
        {launchKind === 'start' && (
          <div className="pane-launch-status" role="status">
            新規セッションを準備しています（git 同期を確認中）…
          </div>
        )}
        {launchKind === 'resume' && (
          <div className="pane-launch-status" role="status">
            再開しています…
          </div>
        )}
        {purpose && (
          <div
            className="pane-purpose"
            title={
              isAwaitingPurposeDecision
                ? '目的は未設定です。最初の発言がこの目的として記録されます。'
                : purpose.text || '未設定'
            }
          >
            目的: {purpose.text || '未設定'}
            {isAwaitingPurposeDecision && (
              <span className="pane-purpose__hint"> — 最初の発言がこの目的になります</span>
            )}
          </div>
        )}
        {displayedError && (
          <div className="pane-error" role="alert">
            {displayedError}
          </div>
        )}
        {archiveWarning && (
          <div className="pane-warning" role="status" title={archiveWarning}>
            アーカイブ同期に問題が発生しました: {archiveWarning}
          </div>
        )}
        {/* M11 (spec §4.2 addendum, ADR-0013, R-8): the git-sync outcome from the most recent "＋ 新規セッ
            ション" launch. blocked-dirty/blocked-busy already got their own native alert dialog main-side
            (D-9) before this ever renders -- this row is the "always visible, never blocks" record of what
            happened (or didn't) for every outcome kind, including the ones that never show a modal.
            FIX M8 (review iter1): a blocked-dirty's full text (repo path + every sample path, one per line)
            previously rendered in full here, permanently stealing several lines of height from the
            `flex: 1` terminal below it. Only the first line is shown by default (ellipsis-truncated, full
            text still on `title` for a quick hover); "詳細"/"閉じる" toggles the full multi-line text on
            demand, and "×" dismisses the row entirely. */}
        {repoSyncNotice && repoSyncFullText && (
          <div
            className={
              repoSyncIsFailed ? 'pane-repo-sync pane-repo-sync--failed' : 'pane-repo-sync'
            }
            role={repoSyncIsFailed ? 'alert' : 'status'}
          >
            <span
              className={
                repoSyncExpanded
                  ? 'pane-repo-sync__text pane-repo-sync__text--expanded'
                  : 'pane-repo-sync__text'
              }
              title={repoSyncFullText}
            >
              {repoSyncExpanded ? repoSyncFullText : repoSyncFirstLine}
            </span>
            {repoSyncHasMoreLines && (
              <button
                type="button"
                className="pane-repo-sync__toggle"
                aria-expanded={repoSyncExpanded}
                onClick={() => setRepoSyncExpanded((v) => !v)}
              >
                {repoSyncExpanded ? '折りたたむ' : '詳細'}
              </button>
            )}
            <button
              type="button"
              className="pane-repo-sync__dismiss"
              onClick={() => setRepoSyncNotice(null)}
              aria-label="この通知を閉じる"
            >
              ×
            </button>
          </div>
        )}
        {session && (
          <div className="pane-telemetry">
            session: {session.id.slice(0, 12)} | model: {session.model ?? '(unknown)'} | tokens
            in/out: {session.tokensIn}/{session.tokensOut}
            {session.endedAt !== null ? ' | ended' : ''}
          </div>
        )}
      </div>
      <div className="pane-terminal-wrap">
        <div className="pane-terminal" ref={containerRef} />
        {/* M4 FIX (usability #3, TD-7): a running pane's black-and-empty terminal was previously the
            only visual state shown while an active purpose awaits "再開" -- indistinguishable from a
            pane that had simply never been used. Mirrors mocks/cockpit-storyboard.html's resume scene:
            a prominent centered affordance naming the pending purpose and explaining --continue's
            no-auto-launch behavior, with the actual resume action promoted here from the header. */}
        {!running && isActivePurpose && (
          <div className="pane-resume-overlay" role="group" aria-label={`再開待ち: ${headerTitle}`}>
            {/* M4 FIX (usability #3): a purpose that never got past its first (undecided) message before
                the pty stopped previously showed "◷ 継続中の目的があります" right next to "未設定" --
                read together, that looked like a bug (a "continuing purpose" that has no purpose). Word
                this state as "目的未設定のセッション" instead so the two lines agree. */}
            {isActivePurposeTextUndecided ? (
              <div className="pane-resume-overlay__badge">
                ◷ 目的未設定のセッションを再開できます
              </div>
            ) : (
              <>
                <div className="pane-resume-overlay__badge">◷ 継続中の目的があります</div>
                <div className="pane-resume-overlay__title">{headerTitle}</div>
              </>
            )}
            <div className="pane-resume-overlay__hint">
              前回の会話を <code>--continue</code> で復元します（自動起動はしません）
            </div>
            <button
              type="button"
              className="pane-resume-overlay__button"
              onClick={() => void handleResume()}
              disabled={!claudeResolved || !defaultCwd || launchKind !== null}
              title={claudeResolved ? undefined : 'claude CLI が見つからないため起動できません'}
            >
              ▶ 再開
            </button>
          </div>
        )}
      </div>
      {showDialog && defaultCwd && (
        <PurposeDialog
          pane={paneIndex}
          cwd={defaultCwd}
          onCancel={() => setShowDialog(false)}
          onConfirm={(text) => void handleConfirmDialog(text)}
        />
      )}
      {showEvaluation && purpose && (
        <EvaluationDialog
          purposeId={purpose.id}
          purposeTitle={purpose.title}
          onClose={closeEvaluationDialog}
        />
      )}
    </div>
  )
}
