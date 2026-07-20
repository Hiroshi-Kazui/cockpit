// Orchestrates the archive-output mirror (spec §4.4.1, ADR-0008 + ADR-0009): asynchronously copies the
// spool's append-only growth (and metadata.json snapshots) into a user-configured output root, entirely
// fire-and-forget with respect to pty/renderer (D-2 -- never blocks a claude session or the UI thread).
//
// Design (mirrors sessionCoordinator.ts's dependency-inversion style: narrow injected ports, no direct
// fs/DB/Electron access here, so this whole engine is unit-testable against in-memory fakes):
//
// - Per-session debounce + in-flight guard (`runOnce`) coalesces bursts of onTranscriptAppended/
//   onMetadataWritten calls into one sync pass, and a change that arrives *while* a pass is running is
//   remembered and re-run immediately after (never dropped).
// - A failed pass records archive_mirror.state='error' + last_error and retries with exponential backoff
//   (never silently gives up, never blocks the caller -- D-2/D-5) -- *unless* the row is the ADR-0009
//   sentinel (a confirmed content-mismatch, permanent, never auto-retried; see UNRECOVERABLE_SYNCED_BYTES).
// - setOutputRoot(newRoot) rebaselines every currently-known spool session's per-(session, newRoot) progress
//   row (ADR-0009: archive_mirror is keyed by (session_id, dest_root), so switching roots never erases a
//   different root's own progress) before switching dest_root: only bytes appended *after* this point are
//   ever auto-mirrored to a brand-new root (D-4 "新規分のみ新出力先へ同期される"). Pre-existing history is
//   left for an explicit startBackfill() call (D-4 "自動実行しない"). Switching *back* to a root this
//   session was already tracked against re-verifies (rather than blindly trusting) its recorded progress
//   against the destination's actual current content before resuming (ADR-0009 decision 3) -- this is what
//   lets an A -> B -> A round trip resume automatically instead of the M6 single-row schema's permanent
//   safe-stop.
// - recoverOnStartup() re-enqueues every archive_mirror row for the currently-configured root
//   unconditionally; a session that's already fully caught up is a cheap no-op (computeTranscriptMirrorDiff
//   returns 'noop'), so this safely absorbs whatever an unclean shutdown left behind (D-6 crash recovery).
import type { ArchiveMirrorRepoPort, ArchiveMirrorRow } from '../../db/archiveMirrorRepo'
import {
  computeBackfillPlan,
  computeResumeVerificationRange,
  computeTranscriptMirrorDiff,
  isUnrecoverableSyncedBytes,
  UNRECOVERABLE_SYNCED_BYTES
} from '../../../shared/mirrorPlan'
import type { BackfillProgressEvent, MirrorStatusSummary } from '../../../shared/ipc'
import type { ArchiveSink } from './sink'
import type { SpoolReader } from './spoolReader'

export interface MirrorCoordinatorDeps {
  repo: ArchiveMirrorRepoPort
  spool: SpoolReader
  createSink: (destRoot: string) => ArchiveSink
  now?: () => number
  debounceMs?: number
  baseRetryDelayMs?: number
  maxRetryDelayMs?: number
  /** Pushed whenever any session's mirror row changes state, so main/index.ts can forward a fresh
   * `getStatusSummary()` snapshot to the renderer (D-5: mirror errors must be visible, never silent). */
  onStatusChanged?: () => void
}

/** The subset of MirrorCoordinator's API the IPC layer (main/ipc/handlers.ts) needs -- kept narrow so
 * handlers.test.ts can inject a fake, the same pattern as ArchiveBrowserPort/PurposeCoordinator. */
export interface MirrorControlPort {
  getOutputRoot(): string | null
  setOutputRoot(root: string | null): void
  getStatusSummary(): MirrorStatusSummary
  startBackfill(onProgress: (event: BackfillProgressEvent) => void): Promise<void>
}

const DEFAULT_DEBOUNCE_MS = 1000
const DEFAULT_BASE_RETRY_MS = 2000
const DEFAULT_MAX_RETRY_MS = 60_000

export class MirrorCoordinator implements MirrorControlPort {
  private readonly repo: ArchiveMirrorRepoPort
  private readonly spool: SpoolReader
  private readonly createSinkFn: (destRoot: string) => ArchiveSink
  private readonly now: () => number
  private readonly debounceMs: number
  private readonly baseRetryDelayMs: number
  private readonly maxRetryDelayMs: number
  private readonly onStatusChanged: () => void

  private currentRoot: string | null = null
  private sink: ArchiveSink | null = null
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly retryDelays = new Map<string, number>()
  private readonly inFlight = new Set<string>()
  private readonly pendingRerun = new Set<string>()
  // M7 followup (structure #2): while a backfill loop is running, per-session markSynced/recordError calls
  // below skip their individual onStatusChanged() push (each one would otherwise trigger a fresh
  // getStatusSummary() -- an O(session-count) scan of archive_mirror -- for every one of the N sessions
  // backfill touches, an O(N^2) total cost). A single push happens once the whole backfill completes
  // instead; the UI already gets fine-grained progress via startBackfill's own onProgress callback.
  private backfillDepth = 0

  constructor(deps: MirrorCoordinatorDeps) {
    this.repo = deps.repo
    this.spool = deps.spool
    this.createSinkFn = deps.createSink
    this.now = deps.now ?? Date.now
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.baseRetryDelayMs = deps.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_MS
    this.maxRetryDelayMs = deps.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_MS
    this.onStatusChanged = deps.onStatusChanged ?? ((): void => {})
  }

  getOutputRoot(): string | null {
    return this.currentRoot
  }

  /** Called (via main/index.ts) whenever the archiver syncs new bytes into a session's spool
   * transcript.jsonl copy. A no-op entirely (not even a timer is armed) while no output root is
   * configured -- AC "archive_output_root 未設定ならミラー系を起動しない". */
  onTranscriptAppended(sessionId: string): void {
    this.scheduleSync(sessionId)
  }

  /** Called (via main/index.ts, wrapping DebouncedMetadataWriter's `write` callback) right after
   * metadata.json is actually written to the spool. Same no-op-while-unconfigured behavior as above. */
  onMetadataWritten(sessionId: string): void {
    this.scheduleSync(sessionId)
  }

  private scheduleSync(sessionId: string, delayMs = this.debounceMs): void {
    if (this.currentRoot === null) return
    const existing = this.debounceTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.debounceTimers.delete(sessionId)
      void this.runOnce(sessionId)
    }, delayMs)
    this.debounceTimers.set(sessionId, timer)
  }

  private clearSessionTimers(sessionId: string): void {
    const debounce = this.debounceTimers.get(sessionId)
    if (debounce) {
      clearTimeout(debounce)
      this.debounceTimers.delete(sessionId)
    }
    const retry = this.retryTimers.get(sessionId)
    if (retry) {
      clearTimeout(retry)
      this.retryTimers.delete(sessionId)
    }
  }

  /** ADR-0008/D-4: switching (or first configuring) the output root never auto-copies pre-existing spool
   * history to a root that has nothing there yet for this session -- such sessions are rebaselined to
   * "already caught up as of right now", so only future appends/metadata writes flow to the new root
   * automatically. `null` disables mirroring entirely (cancels all in-flight timers; existing archive_mirror
   * rows and any already-mirrored destination files are left untouched, per D-4).
   *
   * This is also the entry point main/index.ts calls at app startup to restore a persisted root -- in that
   * case `newRoot` already has archive_mirror rows from before the restart, each already keyed to this exact
   * root (ADR-0009), so rebaselineSession's own resume-verification below is what protects those rows'
   * in-progress sync state; recoverOnStartup then picks up any tail an unclean shutdown left unsynced (D-6).
   */
  setOutputRoot(newRoot: string | null): void {
    const prevRoot = this.currentRoot
    for (const sessionId of [...this.debounceTimers.keys(), ...this.retryTimers.keys()]) {
      this.clearSessionTimers(sessionId)
    }
    this.retryDelays.clear()
    this.currentRoot = newRoot
    this.sink = newRoot ? this.createSinkFn(newRoot) : null

    // Push a status snapshot immediately, even when there is nothing (yet) to rebaseline below (e.g. a
    // brand-new install with zero archived sessions) -- otherwise the renderer's live root-changed
    // indicator would stay stale until the first session-level change happened to fire onStatusChanged.
    this.onStatusChanged()

    if (newRoot === null || newRoot === prevRoot) return

    for (const sessionId of this.spool.listSpoolSessionIds()) {
      void this.rebaselineSession(sessionId, newRoot)
    }
  }

  /**
   * ADR-0009: called once per (session, root) whenever setOutputRoot switches to `root`, deciding how to
   * (re)start tracking `sessionId` there. With the composite `(session_id, dest_root)` key, each root keeps
   * its own row -- switching away and back no longer erases progress the way the M6 single-row schema did.
   * Four cases:
   *
   * 0. A sentinel (permanent, confirmed content-mismatch) row already exists for this exact
   *    (session, root) -- left completely untouched: no re-verification, no retry (followups: "sentinel 行
   *    はリトライ再スケジュールを抑止", preserving the original diagnostic last_error).
   * 1. No row yet for this (session, root) and the destination is empty -- ordinary D-4 skip-history
   *    baseline: `synced_bytes := spoolSize`, only future growth mirrors automatically.
   * 2. No row yet but the destination already has real content (e.g. right after this schema was migrated
   *    from M6's single-row shape, or a stray leftover from a much older run) -- verified as a genuine,
   *    untouched spool prefix (gap=0) before being adopted; sentinel'd if not.
   * 3. A (non-sentinel) row already exists for this exact root -- a genuine "switched away, now back"
   *    resume. Its recorded `synced_bytes` (a spool-logical offset, possibly ahead of the destination's real
   *    size by a permanent D-4 skip-gap established the first time this root was configured for this
   *    session) is re-verified against the destination's *current* real size and content before resuming
   *    automatic sync -- catching the destination having been modified out-of-band while this session was
   *    mirrored elsewhere (decision 3). Nothing is written back to the DB when verification confirms an
   *    already-'synced'/'pending' row is still correct (writing again would risk racing the ordinary sync
   *    engine also acting on the same row, see mirrorCoordinator.test.ts's startup-recovery regression
   *    test) -- but a row recovering from a (non-sentinel) transient error *is* written, clearing it back
   *    to 'synced' now that the destination has been confirmed reachable and consistent again.
   *
   * A transient I/O failure *while verifying* (destination temporarily unreachable) is distinguished from a
   * genuine, confirmed content mismatch (decision 4, followups "transient I/O 失敗が恒久 sentinel に昇格"):
   * the former is recorded as an ordinary (retryable) error and retried; the latter is sentinel'd and never
   * retried automatically.
   */
  private async rebaselineSession(sessionId: string, root: string): Promise<void> {
    // FIX (major, code review): captured here -- at the method's very entry, before any `await` -- and
    // used exclusively from here on, the same discipline `runOnce` already follows. Capturing `this.sink`
    // only *after* an await (as a prior revision did) would let a `setOutputRoot` call that lands during
    // that await swap in a *different* root's sink while `root` (the argument) still names the old one,
    // evaluating the wrong destination's content against this session's row.
    const sink = this.sink
    if (!sink) return // setOutputRoot(null) raced this call -- nothing to do

    const existing = this.repo.get(sessionId, root)
    if (existing?.state === 'error' && isUnrecoverableSyncedBytes(existing.syncedBytes)) {
      return
    }

    const spoolSize = await this.spool.statSpoolTranscript(sessionId)
    if (spoolSize === null) return

    try {
      const destSize = (await sink.statTranscript(sessionId)) ?? 0

      if (!existing && destSize === 0) {
        this.repo.upsert({
          sessionId,
          destRoot: root,
          syncedBytes: spoolSize,
          metaSynced: false,
          state: 'synced',
          lastError: null,
          updatedAt: this.now()
        })
        this.onStatusChanged()
        return
      }

      // Case 2 (no prior row, real content already there) candidates a gap=0 baseline (recordedSyncedBytes
      // := destSize); case 3 (existing row) uses its own recorded logical offset, gap and all.
      const recordedSyncedBytes = existing ? existing.syncedBytes : destSize
      const range = computeResumeVerificationRange({ destSize, recordedSyncedBytes })

      if (range.ok) {
        const [spoolBytes, destBytes] = await Promise.all([
          this.spool.readSpoolBytes(sessionId, range.offset, range.length),
          sink.readTranscriptPrefix(sessionId, destSize)
        ])
        if (spoolBytes.equals(destBytes)) {
          // Only write when there is something to actually change: a brand-new row being adopted, or an
          // existing row recovering from a (non-sentinel) transient error this same verification just
          // cleared. An already-'synced'/'pending' existing row is left completely untouched -- writing the
          // same recordedSyncedBytes back here would risk regressing a *newer* value a concurrently-running
          // ordinary sync pass (runOnce/syncTranscript) may have already written for this exact row (see
          // mirrorCoordinator.test.ts's startup-recovery regression test, where exactly this race mattered).
          if (!existing || existing.state === 'error') {
            this.repo.upsert({
              sessionId,
              destRoot: root,
              syncedBytes: recordedSyncedBytes,
              metaSynced: existing?.metaSynced ?? false,
              state: 'synced',
              lastError: null,
              updatedAt: this.now()
            })
            this.onStatusChanged()
          }
          return
        }
      }

      // Either the recorded/destination sizes are structurally impossible (range not ok) or a genuine
      // content mismatch was found -- a confirmed, deterministic problem (not an I/O hiccup), so this is
      // permanent (ADR-0009 decisions 3/4): sentinel-block, never auto-append here again.
      this.repo.upsert({
        sessionId,
        destRoot: root,
        syncedBytes: UNRECOVERABLE_SYNCED_BYTES,
        metaSynced: false,
        state: 'error',
        lastError: range.ok
          ? `出力先 ${root} のセッション ${sessionId} の既存データがスプールの正当な内容と一致しません` +
            '（外部で変更された可能性があります）。自動同期を中止しました'
          : range.reason,
        updatedAt: this.now()
      })
      this.onStatusChanged()
    } catch (err) {
      // Transient I/O failure while verifying (e.g. the destination briefly unreachable) -- do NOT
      // escalate to the permanent sentinel (ADR-0009 decision 4). Recorded visibly (D-5) with the
      // previously-recorded synced_bytes preserved (never the sentinel value) so a retry can succeed once
      // the destination is reachable again, instead of being permanently refused.
      this.repo.upsert({
        sessionId,
        destRoot: root,
        syncedBytes: existing?.syncedBytes ?? 0,
        metaSynced: existing?.metaSynced ?? false,
        state: 'error',
        lastError:
          `出力先 ${root} のセッション ${sessionId} を確認できません` +
          `（一時的なエラーの可能性があります）: ${err instanceof Error ? err.message : String(err)}`,
        updatedAt: this.now()
      })
      this.onStatusChanged()
      this.scheduleRetry(sessionId, () => this.rebaselineSession(sessionId, root))
    }
  }

  /** ADR-0008/D-6 crash recovery: re-enqueue every row tracked against the currently-configured root.
   * Safe to call unconditionally on every startup -- a fully caught-up session's pass below is a fast
   * no-op (computeTranscriptMirrorDiff returns 'noop'), so this only ever does real work for rows an
   * unclean shutdown left behind mid-sync. No-op entirely while unconfigured. */
  recoverOnStartup(): void {
    if (this.currentRoot === null) return
    for (const row of this.repo.listForDestRoot(this.currentRoot)) {
      this.scheduleSync(row.sessionId, 0)
    }
  }

  getStatusSummary(): MirrorStatusSummary {
    if (this.currentRoot === null) return { outputRoot: null, entries: [] }
    // ADR-0009: scoped to the currently-configured root's own rows only -- a session's rows for other
    // (previously-visited) roots are never mixed into this list (AC "状態UI・バックフィルの対象が「現在の
    // 出力先の行」に絞られ、旧 root の行が混入表示されない").
    const rows = this.repo.listForDestRoot(this.currentRoot)
    return {
      outputRoot: this.currentRoot,
      entries: rows.map((row) => ({
        sessionId: row.sessionId,
        state: row.state,
        lastError: row.lastError,
        updatedAt: row.updatedAt
      }))
    }
  }

  /** ADR-0008/D-4 "自動実行しない": the one explicit way to fully replicate a past session's history to
   * the currently-configured root, bypassing the "skip pre-existing history" baseline normal automatic
   * mirroring uses. Reports progress (and a final `done: true`) via `onProgress` so a long-running
   * backfill is never silently unaccounted-for (D-5). Per-session status pushes are suppressed during the
   * loop (`backfillDepth`, see its doc comment) -- one aggregate push happens once the whole backfill ends. */
  async startBackfill(onProgress: (event: BackfillProgressEvent) => void): Promise<void> {
    if (this.currentRoot === null || this.sink === null) {
      onProgress({ totalSessions: 0, processedSessions: 0, failedSessions: 0, done: true })
      return
    }
    const root = this.currentRoot
    const sink = this.sink
    const sessionIds = this.spool.listSpoolSessionIds()
    const total = sessionIds.length
    let processed = 0
    let failed = 0
    onProgress({ totalSessions: total, processedSessions: 0, failedSessions: 0, done: total === 0 })

    this.backfillDepth++
    try {
      for (const sessionId of sessionIds) {
        try {
          const destSize = (await sink.statTranscript(sessionId)) ?? 0
          const existing = this.repo.get(sessionId, root)
          const recordedSyncedBytes = existing?.syncedBytes ?? 0
          const plan = computeBackfillPlan({ destSize, recordedSyncedBytes })

          if (plan.action === 'refuse') {
            this.recordError(sessionId, root, new Error(plan.reason))
            failed++
          } else {
            this.repo.upsert({
              sessionId,
              destRoot: root,
              syncedBytes: plan.rebaselineSyncedBytes,
              metaSynced: existing?.metaSynced ?? false,
              state: 'pending',
              lastError: null,
              updatedAt: this.now()
            })
            await this.runOnce(sessionId)
            const row = this.repo.get(sessionId, root)
            if (row?.state === 'error') failed++
          }
        } catch {
          failed++
        }
        processed++
        onProgress({
          totalSessions: total,
          processedSessions: processed,
          failedSessions: failed,
          done: processed === total
        })
      }
    } finally {
      this.backfillDepth--
      if (this.backfillDepth === 0) this.onStatusChanged()
    }
  }

  /** Core sync pass for one session: copies the not-yet-mirrored transcript tail (if any) and refreshes
   * metadata.json at the destination. Guarded by `inFlight` so a debounce-timer-triggered run and a
   * directly-awaited one (startBackfill/recoverOnStartup) can never race each other for the same session --
   * a request that arrives while a pass is already running is remembered in `pendingRerun` and re-run
   * immediately after, never dropped. */
  private async runOnce(sessionId: string): Promise<void> {
    if (this.currentRoot === null || this.sink === null) return
    if (this.inFlight.has(sessionId)) {
      this.pendingRerun.add(sessionId)
      return
    }
    this.inFlight.add(sessionId)
    const root = this.currentRoot
    const sink = this.sink
    try {
      const existing = this.repo.get(sessionId, root)
      if (existing?.state === 'error' && isUnrecoverableSyncedBytes(existing.syncedBytes)) {
        // Permanently blocked for this root (confirmed content mismatch, ADR-0009 decision 4) -- return
        // without touching anything: no retry rearm (followups "60s バックオフで永続リトライ"), and
        // critically no call into syncMetadata either, whose markSynced would otherwise silently clobber
        // this sentinel's state='error' back to 'synced' (and the diagnostic last_error along with it,
        // followups "診断 last_error がリトライで上書き").
        return
      }
      await this.syncTranscript(sessionId, root, sink)
      await this.syncMetadata(sessionId, root, sink)
      this.retryDelays.delete(sessionId)
      const retryTimer = this.retryTimers.get(sessionId)
      if (retryTimer) {
        clearTimeout(retryTimer)
        this.retryTimers.delete(sessionId)
      }
    } catch (err) {
      this.recordError(sessionId, root, err)
      this.scheduleRetry(sessionId)
    } finally {
      this.inFlight.delete(sessionId)
      if (this.pendingRerun.delete(sessionId)) {
        void this.runOnce(sessionId)
      }
    }
  }

  /** Schedules `operation` (defaulting to an ordinary `runOnce` retry) after an exponential backoff.
   * Generalized (rather than hardcoded to `runOnce`) so rebaselineSession's own transient-I/O-failure path
   * can reuse the same backoff bookkeeping to retry *verification* instead of an ordinary sync pass. */
  private scheduleRetry(
    sessionId: string,
    operation: () => Promise<void> = () => this.runOnce(sessionId)
  ): void {
    const prevDelay = this.retryDelays.get(sessionId) ?? this.baseRetryDelayMs / 2
    const nextDelay = Math.min(prevDelay * 2, this.maxRetryDelayMs)
    this.retryDelays.set(sessionId, nextDelay)
    const existing = this.retryTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.retryTimers.delete(sessionId)
      void operation()
    }, nextDelay)
    this.retryTimers.set(sessionId, timer)
  }

  /**
   * `synced_bytes` (DB) tracks the spool's logical read offset -- "how many leading spool bytes are
   * already accounted for towards the current destination", whether because they were genuinely sent, or
   * because setOutputRoot's rebaseline deliberately decided to skip them (D-4). The *destination write*
   * offset is a separate, always-ground-truth-verified quantity: the destination file's actual current
   * size (`sink.statTranscript`). These two only coincide when nothing has ever been skipped; after a
   * skip-rebaseline, `synced_bytes` is intentionally ahead of the destination's real size by exactly the
   * skipped amount -- reading spool bytes starting at `synced_bytes` but writing them to the destination
   * starting at its *real* size is what correctly produces "only the new part" at the destination
   * (mirrorCoordinator.test.ts's rebaseline test) while still satisfying fsSink's offset-must-match-actual-
   * size append-only guard (never a false "destination is corrupt" error just because history was
   * deliberately skipped).
   */
  private async syncTranscript(sessionId: string, root: string, sink: ArchiveSink): Promise<void> {
    const spoolSize = await this.spool.statSpoolTranscript(sessionId)
    if (spoolSize === null) return // nothing archived to this session yet

    const existing = this.repo.get(sessionId, root)
    const syncedBytes = existing?.syncedBytes ?? 0

    const diff = computeTranscriptMirrorDiff({ spoolSize, syncedBytes })
    if (diff.action === 'error') {
      throw new Error(diff.reason)
    }
    if (diff.action === 'noop') {
      this.markSynced(sessionId, root, syncedBytes, existing?.metaSynced ?? false)
      return
    }
    const buffer = await this.spool.readSpoolBytes(sessionId, diff.offset, diff.length)
    const destOffset = (await sink.statTranscript(sessionId)) ?? 0
    await sink.appendTranscript(sessionId, destOffset, buffer)
    this.markSynced(sessionId, root, diff.offset + diff.length, existing?.metaSynced ?? false)
  }

  private async syncMetadata(sessionId: string, root: string, sink: ArchiveSink): Promise<void> {
    const content = await this.spool.readSpoolMetadata(sessionId)
    if (content === null) return
    await sink.writeMetadata(sessionId, content)
    const existing = this.repo.get(sessionId, root)
    this.markSynced(sessionId, root, existing?.syncedBytes ?? 0, true)
  }

  private markSynced(
    sessionId: string,
    root: string,
    syncedBytes: number,
    metaSynced: boolean
  ): void {
    const row: ArchiveMirrorRow = {
      sessionId,
      destRoot: root,
      syncedBytes,
      metaSynced,
      state: 'synced',
      lastError: null,
      updatedAt: this.now()
    }
    this.repo.upsert(row)
    if (this.backfillDepth === 0) this.onStatusChanged()
  }

  private recordError(sessionId: string, root: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    const existing = this.repo.get(sessionId, root)
    const row: ArchiveMirrorRow = {
      sessionId,
      destRoot: root,
      syncedBytes: existing?.syncedBytes ?? 0,
      metaSynced: existing?.metaSynced ?? false,
      state: 'error',
      lastError: message,
      updatedAt: this.now()
    }
    this.repo.upsert(row)
    if (this.backfillDepth === 0) this.onStatusChanged()
  }
}
