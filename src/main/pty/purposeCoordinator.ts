// Orchestrates the M4 purpose lifecycle (spec §4.2 launch flow, §4.6 lifecycle, TD-1, TD-7): the
// single place that decides what happens when a "新規セッション" dialog is confirmed, a "再開" button
// is pressed, or a "完了" button is pressed. All actual side effects (pty spawn/write, purpose
// persistence, headless title generation, pushing updates to the renderer) are injected as narrow
// function-shaped deps so this class is unit-testable without Electron/pty/SQLite -- the same
// dependency-inversion pattern sessionCoordinator.ts uses via ports.ts.
import type { PaneIndex, PurposeSummary } from '../../shared/ipc'
import type { LaunchReadyReason } from '../../shared/launchReadiness'
import { truncateTitle } from '../../shared/title'
import { normalizeInitialPromptText } from '../../shared/prompt'
import { LaunchReadinessWatcher } from './launchReadinessWatcher'

/** The subset of LaunchReadinessWatcher's API this coordinator needs -- satisfied by the real class,
 * and by a controllable fake in tests (so tests never depend on real timers). */
export interface LaunchWatcherLike {
  onStatusLineEvent(): void
  onPtyOutput(): void
  dispose(): void
}

export interface PurposeCoordinatorDeps {
  /** Spawns claude for a pane; `extraArgs` (e.g. `['--continue']`) are appended after the app's own
   * `--settings` flag. Must throw (propagating ClaudeResolutionError) on resolution/spawn failure. */
  spawnPty: (pane: PaneIndex, cwd: string, extraArgs?: readonly string[]) => { pid: number }
  writeToPty: (pane: PaneIndex, data: string) => void
  /** Resets the pane's session-linkage lifecycle (sessionCoordinator.onPaneLaunched, TD-2/TD-7); the
   * origin controls what the *next* linked session row's `origin` column will be. */
  onPaneLaunched: (pane: PaneIndex, cwd: string, origin: 'dialog' | 'restart') => void
  createPurpose: (pane: PaneIndex, text: string) => PurposeSummary
  getActivePurposeForPane: (pane: PaneIndex) => PurposeSummary | null
  updatePurposeTitle: (id: string, title: string) => PurposeSummary | null
  /** M4 (spec §4.2 "目的が空で開始した場合"): persists a purpose's text once decided from the session's
   * first non-command chat turn. Returns null if the purpose id no longer exists. */
  updatePurposeText: (id: string, text: string) => PurposeSummary | null
  /** M4 (spec §4.4/§5): keeps every already-linked `sessions` row's denormalized `purpose`/`title`
   * columns in sync once a purpose that started empty is decided (backfills stale copies made at link
   * time before the decision landed, e.g. a `/clear`-created row, TD-2). */
  backfillSessionsPurposeText: (purposeId: string, text: string) => void
  backfillSessionsTitle: (purposeId: string, title: string) => void
  /** M4 FIX (major, eventual-consistency): re-schedules the metadata.json sidecar write (via
   * sessionCoordinator's existing debounced emitUpdated path) for every currently-open session linked to
   * `purposeId`, after a text/title backfill above has landed in SQLite. Without this, a purpose decided
   * (or titled) from the first chat turn would only get its on-disk sidecar refreshed by luck, at the next
   * unrelated statusLine/JSONL event or session close -- crashing before that happens leaves the sidecar
   * permanently stale even though SQLite (the source of truth) is already correct. */
  resyncSessionsForPurpose: (purposeId: string) => void
  completePurpose: (id: string) => PurposeSummary | null
  /** Headless `claude -p --model haiku` one-shot (spec §4.2 step 4); rejects on any failure. */
  generateTitle: (purposeText: string) => Promise<string>
  onPurposeUpdated: (summary: PurposeSummary) => void
  createWatcher?: (onReady: (reason: LaunchReadyReason) => void) => LaunchWatcherLike
  /** M9 (ADR-0010 D-1): fired (fire-and-forget -- must not be awaited here) right after a purpose is
   * successfully marked completed, so the evaluation pipeline can start without ever delaying
   * completePurpose's own return value. Optional so existing tests/wiring that predate M9 need no change. */
  onPurposeCompleted?: (purposeId: string) => void
}

function defaultCreateWatcher(onReady: (reason: LaunchReadyReason) => void): LaunchWatcherLike {
  return new LaunchReadinessWatcher({ onReady })
}

export class PurposeCoordinator {
  private readonly watchers = new Map<PaneIndex, LaunchWatcherLike>()
  private readonly deps: PurposeCoordinatorDeps
  private readonly createWatcher: (
    onReady: (reason: LaunchReadyReason) => void
  ) => LaunchWatcherLike

  constructor(deps: PurposeCoordinatorDeps) {
    this.deps = deps
    this.createWatcher = deps.createWatcher ?? defaultCreateWatcher
  }

  /**
   * "新規セッション" dialog confirmed (spec §4.2 steps 1-2). Spawns first (so a claude-resolution
   * failure leaves no orphan purpose row behind), then creates the purpose, arms the TD-1
   * launch-readiness watcher (which sends `purposeText` as the first prompt once ready), and kicks off
   * async title generation in parallel ("並行して", spec §4.2 step 4) -- never blocks the caller.
   *
   * `purposeText` is optional (spec §4.2 "目的テキストの入力は任意"): when it is empty/whitespace-only,
   * the purpose row is still created immediately (with `text=''`, so sessionCoordinator.linkSession has
   * an active purpose to attach the pty's first session to as soon as it links -- deferring creation
   * would risk that first session landing with `purpose_id = NULL` forever), but neither the initial
   * prompt is sent ("初回プロンプトの自動送信は行わない") nor title generation started (nothing to
   * generate a title from yet). The purpose stays active with empty text/title -- rendered as "未設定"
   * (Pane.tsx) -- until PurposeDetectionCoordinator finds the session's first non-command chat turn and
   * calls decidePurposeFromFirstMessage below.
   */
  startNewSession(
    pane: PaneIndex,
    cwd: string,
    purposeText: string
  ): { pid: number; purposeId: string } {
    const trimmedText = purposeText.trim()
    const { pid } = this.deps.spawnPty(pane, cwd)

    const purpose = this.deps.createPurpose(pane, trimmedText)
    this.deps.onPurposeUpdated(purpose)
    this.deps.onPaneLaunched(pane, cwd, 'dialog')

    if (trimmedText.length > 0) {
      this.armLaunch(pane, trimmedText)
      this.generateTitleAsync(purpose, trimmedText)
    }

    return { pid, purposeId: purpose.id }
  }

  /**
   * Called by PurposeDetectionCoordinator (main/telemetry/purposeDetectionCoordinator.ts) once the
   * transcript's first non-command human chat turn is found for a purpose that was started empty (spec
   * §4.2). Persists the purpose's text, backfills every already-linked session row for this purpose
   * (harness-archive completeness, spec §4.4/§5), pushes the update, and kicks off the same async title
   * generation the "dialog with text" flow uses (spec §4.2 step 4: "採用後は通常どおり... タイトルを生成
   * する").
   */
  decidePurposeFromFirstMessage(purposeId: string, text: string): void {
    const updated = this.deps.updatePurposeText(purposeId, text)
    if (!updated) {
      console.error(
        `[purpose] decidePurposeFromFirstMessage: purpose ${purposeId} not found, discarding`
      )
      return
    }
    this.deps.backfillSessionsPurposeText(purposeId, text)
    this.deps.resyncSessionsForPurpose(purposeId)
    this.deps.onPurposeUpdated(updated)
    this.generateTitleAsync(updated, text)
  }

  /**
   * "再開" button pressed (spec §4.6, TD-7): active purpose exists but no pty is running for the pane.
   * `--continue` restores the prior conversation itself, so no initial prompt is sent and no title
   * generation is triggered (the purpose already has one). Spawns first, symmetric with
   * startNewSession above: if spawnPty throws (claude-resolution failure), the pane's session lifecycle
   * (SessionCoordinator, via onPaneLaunched) is left untouched instead of being reset to a 'restart'
   * origin for a process that was never actually started.
   */
  resumeSession(pane: PaneIndex, cwd: string): { pid: number } {
    const purpose = this.deps.getActivePurposeForPane(pane)
    if (!purpose) {
      throw new Error(`Pane ${pane} has no active purpose to resume (spec §4.6, TD-7)`)
    }
    const { pid } = this.deps.spawnPty(pane, cwd, ['--continue'])
    this.deps.onPaneLaunched(pane, cwd, 'restart')
    return { pid }
  }

  /** "完了" button pressed (spec §4.6): marks the purpose completed; future new sessions for this pane
   * go through the dialog again. */
  completePurpose(purposeId: string): PurposeSummary {
    const updated = this.deps.completePurpose(purposeId)
    if (!updated) {
      throw new Error(`Purpose not found: ${purposeId}`)
    }
    this.deps.onPurposeUpdated(updated)
    // M9 (ADR-0010 D-1): kicks off the evaluation pipeline fire-and-forget -- not awaited, so this
    // method's own return (and thus the completePurpose IPC response) is never delayed by it.
    this.deps.onPurposeCompleted?.(updated.id)
    return updated
  }

  /** Call on every pty data chunk for a pane (TD-1 fallback signal); no-op if no launch is pending. */
  notePtyOutput(pane: PaneIndex): void {
    this.watchers.get(pane)?.onPtyOutput()
  }

  /** Call on every statusLine pipe message for a pane (TD-1 primary signal); no-op if no launch is
   * pending. */
  noteStatusLineEvent(pane: PaneIndex): void {
    this.watchers.get(pane)?.onStatusLineEvent()
  }

  /** Call when a pane's pty exits, so a launch that never reached readiness cannot later try to write
   * an initial prompt to a dead process. */
  cancelLaunch(pane: PaneIndex): void {
    this.watchers.get(pane)?.dispose()
    this.watchers.delete(pane)
  }

  private armLaunch(pane: PaneIndex, purposeText: string): void {
    this.cancelLaunch(pane)
    // Collapse internal newlines (Shift+Enter / paste in the purpose dialog's textarea) to spaces
    // before sending: a literal newline followed by the trailing '\r' below would look to the claude
    // TUI like multiple separate Enter presses mid-composition, submitting the prompt prematurely.
    const promptText = normalizeInitialPromptText(purposeText)
    const watcher = this.createWatcher((reason) => {
      console.info(`[launch] pane ${pane} ready via ${reason}; sending initial prompt`)
      this.watchers.delete(pane)
      try {
        this.deps.writeToPty(pane, promptText + '\r')
      } catch (err) {
        // Defense-in-depth: the pty may have exited in the narrow window between the watcher firing
        // and cancelLaunch() being called by the onExit handler. Never let this become an unhandled
        // exception inside a timer callback (silent-failure is prohibited, so log it instead).
        console.error(`[launch] pane ${pane} failed to send initial prompt`, err)
      }
    })
    this.watchers.set(pane, watcher)
  }

  private generateTitleAsync(purpose: PurposeSummary, purposeText: string): void {
    this.deps
      .generateTitle(purposeText)
      .then((title) => {
        const updated = this.deps.updatePurposeTitle(purpose.id, title)
        if (updated) {
          this.deps.backfillSessionsTitle(purpose.id, title)
          this.deps.resyncSessionsForPurpose(purpose.id)
          this.deps.onPurposeUpdated(updated)
        }
      })
      .catch((err: unknown) => {
        console.error(`[title] generation failed for purpose ${purpose.id}, using fallback`, err)
        const fallback = truncateTitle(purposeText)
        const updated = this.deps.updatePurposeTitle(purpose.id, fallback)
        if (updated) {
          this.deps.backfillSessionsTitle(purpose.id, fallback)
          this.deps.resyncSessionsForPurpose(purpose.id)
          this.deps.onPurposeUpdated(updated)
        }
      })
  }
}
