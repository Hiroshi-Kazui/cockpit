// Orchestrates session linkage (TD-2) and ended_at determination (TD-3) by fusing statusLine pipe
// messages with archiver JSONL activity. The only module that decides *when* a `sessions` row is
// created/reopened/closed; SessionStore/PurposeStore/ArchiverPort (ports.ts) stay dumb (pure side
// effects behind a narrow interface), which is what keeps this class unit-testable without a real
// SQLite engine or the Electron runtime.
import path from 'node:path'
import os from 'node:os'
import type { PaneIndex, SessionArchiveErrorEvent, SessionSummary } from '../../shared/ipc'
import { isPaneIndex, toPaneIndex } from '../../shared/ipc'
import {
  isTranscriptPathAllowed,
  isValidSessionId,
  parseStatusLineMessage
} from '../../shared/statusline'
import { aggregateUsage, type ParsedJsonlEntry } from '../../shared/jsonl'
import type { ArchiverPort, PurposeStore, SessionRow, SessionStore } from './ports'

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface PaneState {
  cwd: string | null
  lastSessionId: string | null
  /** True until the pane's first session of this pty lifecycle has been linked; distinguishes
   * origin='dialog'/'restart' (the launch itself, see launchOrigin) from origin='clear' (a later
   * session_id change, TD-2). */
  isFirstSessionInLifecycle: boolean
  /** What kind of launch started this pty lifecycle (M4, TD-7): 'dialog' for the "新規セッション"
   * flow, 'restart' for the one-click "再開" (--continue) flow. Determines the *first* linked
   * session's origin; every subsequent session_id change within the same lifecycle is still 'clear'. */
  launchOrigin: 'dialog' | 'restart'
}

export interface SessionCoordinatorDeps {
  store: SessionStore
  purposes: PurposeStore
  archiver: ArchiverPort
  /** Builds the archive directory for a session_id. Returns null when the resulting path would escape
   * the archive root (M2 FIX: containment check, defense-in-depth alongside isValidSessionId below). */
  archiveDirFor: (sessionId: string) => string | null
  onSessionUpdated: (summary: SessionSummary) => void
  /** Surfaces archive-sync failures so they are not silent-to-user (M2 FIX: record-completeness is the
   * app's core purpose, spec §1/§4.4). */
  onArchiveError: (event: SessionArchiveErrorEvent) => void
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  now?: () => number
  /** The directory transcript_path values are expected to live under; injectable for tests. Defaults to
   * `<home>/.claude` (M2 FIX: isTranscriptPathAllowed boundary check). */
  claudeHomeDir?: string
}

export class SessionCoordinator {
  private readonly paneStates = new Map<PaneIndex, PaneState>()
  private readonly activity = new Map<string, number>()
  private readonly store: SessionStore
  private readonly purposes: PurposeStore
  private readonly archiver: ArchiverPort
  private readonly archiveDirFor: (sessionId: string) => string | null
  private readonly onSessionUpdated: (summary: SessionSummary) => void
  private readonly onArchiveError: (event: SessionArchiveErrorEvent) => void
  private readonly now: () => number
  private readonly claudeHomeDir: string

  constructor(deps: SessionCoordinatorDeps) {
    this.store = deps.store
    this.purposes = deps.purposes
    this.archiver = deps.archiver
    this.archiveDirFor = deps.archiveDirFor
    this.onSessionUpdated = deps.onSessionUpdated
    this.onArchiveError = deps.onArchiveError
    this.now = deps.now ?? Date.now
    this.claudeHomeDir = deps.claudeHomeDir ?? path.join(os.homedir(), '.claude')
  }

  private stateFor(pane: PaneIndex): PaneState {
    let state = this.paneStates.get(pane)
    if (!state) {
      state = {
        cwd: null,
        lastSessionId: null,
        isFirstSessionInLifecycle: true,
        launchOrigin: 'dialog'
      }
      this.paneStates.set(pane, state)
    }
    return state
  }

  /** Call when a fresh pty is spawned for a pane. Resets the pane's session lifecycle so the next
   * linked session_id is treated as origin=`launchOrigin` (M4, TD-7): 'dialog' for the "新規セッション"
   * flow (default, preserves M2 behavior), 'restart' for the one-click "再開" flow. */
  onPaneLaunched(
    pane: PaneIndex,
    cwd: string,
    launchOrigin: 'dialog' | 'restart' = 'dialog'
  ): void {
    this.paneStates.set(pane, {
      cwd,
      lastSessionId: null,
      isFirstSessionInLifecycle: true,
      launchOrigin
    })
  }

  /** TD-3 path 1: the pty process exited. */
  onPtyExited(pane: PaneIndex): void {
    const state = this.paneStates.get(pane)
    if (state?.lastSessionId) this.closeSession(state.lastSessionId)
    this.paneStates.delete(pane)
  }

  /** TD-3 path 3: app is quitting -- close every still-open session. */
  closeAllOpenSessions(): void {
    for (const row of this.store.getAllOpenSessions()) this.closeSession(row.id)
    this.paneStates.clear()
  }

  private recordActivity(sessionId: string, timestampMs: number): void {
    const prev = this.activity.get(sessionId) ?? 0
    if (timestampMs > prev) this.activity.set(sessionId, timestampMs)
  }

  private closeSession(sessionId: string): void {
    const row = this.store.getSession(sessionId)
    if (!row || row.endedAt !== null) return
    // TD-3: ended_at is the last *observed* activity time, not the close-detection time.
    const endedAt = this.activity.get(sessionId) ?? this.now()
    this.store.closeSession(sessionId, endedAt)
    this.archiver.detach(sessionId)
    this.activity.delete(sessionId)
    this.emitUpdated(sessionId)
  }

  private emitUpdated(sessionId: string): void {
    const row = this.store.getSession(sessionId)
    if (!row) return
    this.onSessionUpdated(toSummary(row))
  }

  /** Entry point for a raw JSON-Lines message parsed off the telemetry pipe. Never throws. */
  onRawMessage(raw: unknown): void {
    const message = parseStatusLineMessage(raw)
    if (!message) {
      console.error('[telemetry] discarding unparseable pipe message')
      return
    }
    if (message.pane === null || !isPaneIndex(message.pane)) {
      console.error('[telemetry] pipe message missing/invalid pane, discarding', message)
      return
    }
    if (!message.sessionId || !message.transcriptPath) {
      // Nothing to link without both -- some statusLine renders may fire before a transcript exists.
      return
    }
    // M2 FIX (security): the named pipe this message arrived over is unauthenticated (any local
    // process running as the same OS user can connect, TD-4) and message.sessionId ends up in
    // filesystem path construction downstream (archiveDirFor). Reject anything outside a conservative
    // filename-safe whitelist here, at the boundary, before it can ever reach a path.join/archiver call.
    if (!isValidSessionId(message.sessionId)) {
      console.error(
        '[telemetry] discarding pipe message with invalid session_id',
        message.sessionId
      )
      return
    }

    const pane = message.pane
    const state = this.stateFor(pane)
    const now = this.now()

    if (state.lastSessionId !== message.sessionId) {
      if (state.lastSessionId) this.closeSession(state.lastSessionId)
      this.linkSession(pane, state, message.sessionId, message.transcriptPath, message.model, now)
      state.lastSessionId = message.sessionId
      state.isFirstSessionInLifecycle = false
    } else if (message.model) {
      this.store.updateModelIfNull(message.sessionId, message.model)
    }

    this.recordActivity(message.sessionId, now)
    this.emitUpdated(message.sessionId)
  }

  private linkSession(
    pane: PaneIndex,
    state: PaneState,
    sessionId: string,
    transcriptPath: string,
    model: string | null,
    startedAt: number
  ): void {
    // M2 FIX (security, defense-in-depth): even though sessionId already passed the isValidSessionId
    // whitelist in onRawMessage, verify the archive directory it maps to is still contained within the
    // archive root before doing anything else with it. In normal operation a whitelisted id can never
    // fail this, but this keeps the invariant enforced at every layer, not just one.
    const archiveDir = this.archiveDirFor(sessionId)
    if (!archiveDir) {
      console.error(
        '[telemetry] refusing to link session: archive path escapes archive root, discarding',
        sessionId
      )
      return
    }
    const existing = this.store.getSession(sessionId)
    if (existing) {
      // TD-2: a previously-known session_id resurfacing = /resume. Reopen; origin/purpose/title of the
      // original row are preserved as-is (they describe how the row first came into being).
      // NOTE: this never sets origin to the literal 'resume' value even though the SessionOrigin type
      // (shared/ipc.ts) includes it -- statusLine data alone cannot distinguish "the user ran /resume"
      // from "this session_id simply reappeared" (e.g. after a /clear-then-/resume-back-to-original
      // sequence), so M2 conservatively preserves whatever origin the row was first created with.
      // Deriving a true 'resume' origin would need the pty launch args (e.g. `claude --resume <id>`),
      // which is not part of this milestone's scope.
      //
      // M4 exception (TD-7): if this is the *first* statusLine link of a "再開" (--continue) launch and
      // it resurfaces a session_id claude already knows about (i.e. `--continue` reused rather than
      // minted a fresh session_id for the continued conversation -- the exact behavior isn't guaranteed
      // by spec/TD-7 and `sessions.id` being the session_id itself, per spec §5, means a literal second
      // row is not possible for the same id), the reopened row's origin is overridden to 'restart' so
      // TD-7's "origin='restart' のセッション行" intent still holds even in this edge case.
      const originOverride =
        state.isFirstSessionInLifecycle && state.launchOrigin === 'restart' ? 'restart' : undefined
      this.store.reopenSession(sessionId, originOverride)
    } else {
      const origin = state.isFirstSessionInLifecycle ? state.launchOrigin : 'clear'
      const activePurpose = this.purposes.getActivePurposeForPane(pane)
      this.store.createSession({
        id: sessionId,
        pane,
        purposeId: activePurpose?.id ?? null,
        origin,
        purpose: activePurpose?.text ?? null,
        title: activePurpose?.title ?? null,
        cwd: state.cwd,
        startedAt,
        jsonlPath: path.join(archiveDir, 'transcript.jsonl'),
        model
      })
    }
    // M2 FIX (security): transcript_path is also unauthenticated pipe input and is opened for reading
    // by the archiver (fs.openSync(..., 'r')) -- refuse to attach unless it is an absolute path inside
    // the expected claude transcripts directory, so a spoofed message cannot make the archiver read (and
    // copy into our archive) an arbitrary file elsewhere on disk. The session row above is still
    // created/reopened regardless (it reflects real statusLine activity for this pane), only the
    // archiver attach is skipped.
    if (isTranscriptPathAllowed(transcriptPath, this.claudeHomeDir)) {
      this.archiver.attach(sessionId, transcriptPath, archiveDir)
    } else {
      console.error(
        '[telemetry] refusing to attach archiver: transcript_path outside expected claude directory',
        transcriptPath
      )
      this.onArchiveError({
        sessionId,
        pane,
        message: `transcript_path is outside the expected claude directory: ${transcriptPath}`
      })
    }
  }

  /** Called by the archiver whenever new complete JSONL lines were appended and parsed (spec §4.5). */
  onJsonlEntries(sessionId: string, entries: readonly ParsedJsonlEntry[], mtimeMs: number): void {
    const usage = aggregateUsage(entries)
    this.store.addTokens(sessionId, usage)
    const lastModel = [...entries].reverse().find((e) => e.model)?.model ?? null
    if (lastModel) this.store.updateModelIfNull(sessionId, lastModel)
    this.recordActivity(sessionId, mtimeMs)
    this.emitUpdated(sessionId)
  }

  /** M4 FIX (major, eventual-consistency): PurposeCoordinator calls this right after it decides a
   * purpose's text (from the session's first chat turn, spec §4.2) or a generated/fallback title lands
   * -- both of which persist to SQLite and backfill any already-linked `sessions` rows' denormalized
   * purpose/title columns (main/db/sessionRepo.ts's backfillPurposeText/Title) *without* going through
   * onRawMessage/onJsonlEntries above, so nothing would otherwise re-trigger the metadata.json sidecar
   * write for those sessions until their next telemetry event or app quit. Re-reads every currently-open
   * session for this purpose straight from the store (SQLite remains the single source of truth; this
   * never caches) and re-runs the existing emitUpdated -> onSessionUpdated -> debounced-metadata-write
   * path, so this closes that window deterministically without adding a second write mechanism. */
  resyncSessionsForPurpose(purposeId: string): void {
    for (const row of this.store.getAllOpenSessions()) {
      if (row.purposeId === purposeId) this.emitUpdated(row.id)
    }
  }

  /** Called by the archiver whenever a transcript sync attempt fails (read error, source shrank, disk
   * full, etc.). M2 FIX (major): record-completeness is this app's core purpose (spec §1/§4.4), so this
   * must not stay console-only -- it is surfaced to the relevant pane via onArchiveError. */
  onArchiverError(sessionId: string, err: unknown): void {
    console.error(`[archiver] session ${sessionId}`, err)
    const row = this.store.getSession(sessionId)
    this.onArchiveError({
      sessionId,
      pane: row ? toPaneIndex(row.pane) : null,
      message: describeError(err)
    })
  }
}

function toSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    pane: toPaneIndex(row.pane),
    purposeId: row.purposeId,
    origin: row.origin,
    purpose: row.purpose,
    title: row.title,
    cwd: row.cwd,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    model: row.model,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    tokensCacheRead: row.tokensCacheRead,
    tokensCacheWrite: row.tokensCacheWrite
  }
}
