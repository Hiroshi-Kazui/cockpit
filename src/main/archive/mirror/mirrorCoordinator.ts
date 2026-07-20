// Orchestrates the M6 archive-output mirror (spec §4.4.1, ADR-0008): asynchronously copies the spool's
// append-only growth (and metadata.json snapshots) into a user-configured output root, entirely
// fire-and-forget with respect to pty/renderer (D-2 -- never blocks a claude session or the UI thread).
//
// Design (mirrors sessionCoordinator.ts's dependency-inversion style: narrow injected ports, no direct
// fs/DB/Electron access here, so this whole engine is unit-testable against in-memory fakes):
//
// - Per-session debounce + in-flight guard (`runOnce`) coalesces bursts of onTranscriptAppended/
//   onMetadataWritten calls into one sync pass, and a change that arrives *while* a pass is running is
//   remembered and re-run immediately after (never dropped).
// - A failed pass records archive_mirror.state='error' + last_error and retries with exponential backoff
//   (never silently gives up, never blocks the caller -- D-2/D-5).
// - setOutputRoot(newRoot) rebaselines every currently-known spool session's synced_bytes to its *current*
//   spool size before switching dest_root: only bytes appended *after* this point are ever auto-mirrored
//   to the new root (D-4 "新規分のみ新出力先へ同期される"). Pre-existing history is left for an explicit
//   startBackfill() call (D-4 "自動実行しない").
// - recoverOnStartup() re-enqueues every archive_mirror row for the currently-configured root
//   unconditionally; a session that's already fully caught up is a cheap no-op (computeTranscriptMirrorDiff
//   returns 'noop'), so this safely absorbs whatever an unclean shutdown left behind (D-6 crash recovery).
import type { ArchiveMirrorRepoPort, ArchiveMirrorRow } from '../../db/archiveMirrorRepo'
import { computeTranscriptMirrorDiff } from '../../../shared/mirrorPlan'
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

/** Sentinel `synced_bytes` value recorded for a session whose destination content cannot be safely
 * trusted as a resume point (rebaselineSession's content-prefix verification below failed, or could not
 * be completed). Deliberately far larger than any real transcript could ever grow to, so
 * computeTranscriptMirrorDiff's existing "recorded progress exceeds spool size" guard permanently refuses
 * every future automatic sync attempt for this session+root combination -- `sink.appendTranscript` is
 * then never reached again, so the destination can never be further corrupted. This reuses the *existing*
 * append-only-violation detection (shared/mirrorPlan.ts) instead of adding a new schema column to track
 * "permanently stuck" separately from a merely transient failure (which must keep retrying, D-2's
 * "復旧後に追い付く") -- the single-row archive_mirror schema (spec §5) is unchanged. */
const UNRECOVERABLE_SYNCED_BYTES = Number.MAX_SAFE_INTEGER

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
   * history to a destination that has nothing there yet -- such sessions are rebaselined to "already
   * caught up as of right now", so only future appends/metadata writes flow to the new root automatically.
   * `null` disables mirroring entirely (cancels all in-flight timers; existing archive_mirror rows and any
   * already-mirrored destination files are left untouched, per D-4).
   *
   * This is also the entry point main/index.ts calls at app startup to restore a persisted root -- in that
   * case `newRoot` already has archive_mirror rows from before the restart, each already pointing at this
   * exact root, so rebaselineSession's own check below (existing row already tracks this root -> leave it
   * alone) is what protects those rows' in-progress sync state; recoverOnStartup then picks up any tail an
   * unclean shutdown left unsynced (D-6). A blind, unconditional rebaseline here would otherwise silently
   * discard that unsynced tail on every single restart (crash-recovery bug, fixed by rebaselineSession's
   * row check, not a separate startup code path).
   *
   * A session whose destination already has *real* content under the new root (a genuine "switch back to
   * a root visited before, then away, then back" -- the single-row archive_mirror schema, spec §5, retains
   * no per-root history once a session's row has moved to a different dest_root in between) is neither
   * blindly skip-baselined nor blindly trusted: rebaselineSession verifies the destination's existing bytes
   * are a genuine spool *prefix* before resuming automatic sync against it, and refuses (state='error')
   * rather than risk silently corrupting it if they are not (e.g. a post-skip *suffix* left over from a
   * prior visit to this same root). */
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
   * Decides how (or whether) to start tracking `sessionId` against `root` when the output root is being
   * configured/switched. Three cases:
   *
   * 1. A row already tracks this exact root (`existing.destRoot === root`) -- the app is restarting and
   *    restoring a persisted root, never actually "left" in between. Preserved verbatim: blindly
   *    re-baselining it to "fully caught up" would silently drop any unsynced tail a crash left behind
   *    (ADR-0008/D-6). recoverOnStartup / the next debounced sync picks up exactly where this row left off.
   * 2. The destination is genuinely empty (`destSize === 0`) -- nothing there to conflict with, so the
   *    ordinary D-4 skip-history baseline applies (`synced_bytes := spoolSize`; only future growth mirrors
   *    automatically).
   * 3. The destination already has real content under this root from a *prior* visit (switched away and
   *    back -- the single-row schema, spec §5, no longer remembers that prior visit's own progress once
   *    the row moved to a different dest_root in between). Its existing bytes are read back and compared,
   *    byte-for-byte, against the spool's own leading bytes of the same length:
   *      - If they match, the destination genuinely holds a spool *prefix* -- safe to resume exactly where
   *        it leaves off (`synced_bytes := destSize`), aligning syncTranscript's future read offset with
   *        its write offset (`sink.statTranscript`) so they can never diverge again.
   *      - If they don't match (or the safety check itself fails, e.g. the destination becomes unreadable
   *        mid-check), the destination's bytes are a post-skip *suffix*, not a prefix -- resuming would
   *        read the wrong spool range and silently corrupt it. Refused outright: recorded with the
   *        UNRECOVERABLE_SYNCED_BYTES sentinel (permanently keeps computeTranscriptMirrorDiff refusing to
   *        proceed for this session+root, so `sink.appendTranscript` is never reached again) and
   *        `state='error'`.
   */
  private async rebaselineSession(sessionId: string, root: string): Promise<void> {
    const existing = this.repo.get(sessionId)
    if (existing && existing.destRoot === root) {
      return
    }
    const spoolSize = await this.spool.statSpoolTranscript(sessionId)
    if (spoolSize === null) return

    try {
      const destSize = this.sink ? ((await this.sink.statTranscript(sessionId)) ?? 0) : 0

      if (destSize === 0) {
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

      const boundedLength = Math.min(destSize, spoolSize)
      const [spoolPrefix, destPrefix] = await Promise.all([
        this.spool.readSpoolBytes(sessionId, 0, boundedLength),
        this.sink!.readTranscriptPrefix(sessionId, boundedLength)
      ])

      if (destSize <= spoolSize && spoolPrefix.equals(destPrefix)) {
        this.repo.upsert({
          sessionId,
          destRoot: root,
          syncedBytes: destSize,
          metaSynced: false,
          state: 'synced',
          lastError: null,
          updatedAt: this.now()
        })
        this.onStatusChanged()
        return
      }

      this.repo.upsert({
        sessionId,
        destRoot: root,
        syncedBytes: UNRECOVERABLE_SYNCED_BYTES,
        metaSynced: false,
        state: 'error',
        lastError:
          `cannot resume mirroring session ${sessionId} to ${root}: its existing ${destSize} byte(s) ` +
          'there do not match a genuine prefix of the spool (likely left over from a different sync ' +
          'history against this same output root) -- refusing to risk corrupting it with an automatic append',
        updatedAt: this.now()
      })
      this.onStatusChanged()
    } catch (err) {
      // The safety check itself failed (e.g. the destination became unreadable mid-verification) --
      // treat as inconclusive and refuse, same as an explicit prefix mismatch above, rather than silently
      // falling back to an unverified resume.
      this.repo.upsert({
        sessionId,
        destRoot: root,
        syncedBytes: UNRECOVERABLE_SYNCED_BYTES,
        metaSynced: existing?.metaSynced ?? false,
        state: 'error',
        lastError: `could not verify session ${sessionId}'s existing content at ${root}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        updatedAt: this.now()
      })
      this.onStatusChanged()
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
   * backfill is never silently unaccounted-for (D-5).
   *
   * Implementation: rebases `synced_bytes` down to the destination's *real, currently-verified* size
   * (never a blind literal 0 -- see syncTranscript's doc comment on why `synced_bytes`/destination-size can
   * legitimately differ) before running one ordinary sync pass. For a session whose destination is still
   * empty (the "skipped history" case, destSize === 0), this makes the ordinary pass copy the *entire*
   * spool content from scratch, which is safe -- there is nothing at the destination yet to conflict with.
   * For a session that already has real content there and was never skipped (`recordedSyncedBytes` already
   * equals `destSize`, i.e. every mirrored byte genuinely is a spool *prefix*), this is a no-op rebase
   * followed by an ordinary catch-up sync.
   *
   * If the destination already holds *some* real bytes (`destSize > 0`) for a session whose recorded
   * progress is *ahead* of that (`recordedSyncedBytes > destSize`), those destination bytes are known to be
   * a post-skip *suffix* of the spool (e.g. spool[100:150] after a rebaseline skipped spool[0:100]), not a
   * prefix -- rebasing `synced_bytes` down to `destSize` and resuming a normal sync would then read the
   * *wrong* spool range and append it, corrupting the destination with duplicated/interleaved content. That
   * combination is refused outright (recorded as `state='error'`) rather than silently corrupting it: under
   * append-only, a full backfill genuinely cannot be done safely for that session without first clearing
   * its destination by hand, which this app has no delete path for (by design). */
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

    for (const sessionId of sessionIds) {
      try {
        const destSize = (await sink.statTranscript(sessionId)) ?? 0
        const existing = this.repo.get(sessionId)
        const recordedSyncedBytes =
          existing && existing.destRoot === root ? existing.syncedBytes : 0

        if (destSize > 0 && recordedSyncedBytes > destSize) {
          this.recordError(
            sessionId,
            root,
            new Error(
              `cannot backfill session ${sessionId}: its destination already holds ${destSize} byte(s) ` +
                'that are not a full prefix of the spool (history was previously skipped for this output ' +
                'root) -- a full backfill would corrupt the already-mirrored content, so it was refused'
            )
          )
          failed++
        } else {
          this.repo.upsert({
            sessionId,
            destRoot: root,
            syncedBytes: destSize,
            metaSynced: existing?.destRoot === root ? existing.metaSynced : false,
            state: 'pending',
            lastError: null,
            updatedAt: this.now()
          })
          await this.runOnce(sessionId)
          const row = this.repo.get(sessionId)
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

  private scheduleRetry(sessionId: string): void {
    const prevDelay = this.retryDelays.get(sessionId) ?? this.baseRetryDelayMs / 2
    const nextDelay = Math.min(prevDelay * 2, this.maxRetryDelayMs)
    this.retryDelays.set(sessionId, nextDelay)
    const existing = this.retryTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.retryTimers.delete(sessionId)
      void this.runOnce(sessionId)
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

    const existing = this.repo.get(sessionId)
    // A row for a *different* dest_root (stale/never rebaselined -- e.g. a brand-new session created
    // after the root was already set, which setOutputRoot's rebaseline pass never saw) starts fresh: this
    // genuinely is new data for the current root, so a synced_bytes baseline of 0 is correct here, not a
    // bug -- setOutputRoot's skip-history behavior only applies to sessions that already existed *before*
    // the switch (mirrorCoordinator.test.ts covers both cases).
    const syncedBytes = existing && existing.destRoot === root ? existing.syncedBytes : 0

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
    const existing = this.repo.get(sessionId)
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
    this.onStatusChanged()
  }

  private recordError(sessionId: string, root: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    const existing = this.repo.get(sessionId)
    const row: ArchiveMirrorRow = {
      sessionId,
      destRoot: existing?.destRoot ?? root,
      syncedBytes: existing?.syncedBytes ?? 0,
      metaSynced: existing?.metaSynced ?? false,
      state: 'error',
      lastError: message,
      updatedAt: this.now()
    }
    this.repo.upsert(row)
    this.onStatusChanged()
  }
}
