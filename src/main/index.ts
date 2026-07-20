// Main process entry point: app lifecycle, BrowserWindow creation, IPC wiring, graceful shutdown.
import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb, closeDb } from './db/db'
import { getAppSettings } from './db/appSettingsRepo'
import { createSqliteArchiveMirrorRepo } from './db/archiveMirrorRepo'
import {
  backfillPurposeText,
  backfillPurposeTitle,
  createSqliteSessionStore,
  getSession,
  repairOpenSessions
} from './db/sessionRepo'
import {
  completePurpose,
  createPurpose,
  createSqlitePurposeStore,
  getActivePurposeForPane,
  getPurposeById,
  updatePurposeText,
  updatePurposeTitle
} from './db/purposeRepo'
import { registerIpcHandlers, unregisterIpcHandlers } from './ipc/handlers'
import { PtyManager } from './pty/ptyManager'
import { PurposeCoordinator } from './pty/purposeCoordinator'
import { generateTitle } from './pty/titleGenerator'
import { SessionArchiver } from './archive/archiver'
import {
  createDebouncedMetadataWriter,
  writeSessionMetadata,
  type DebouncedMetadataWriter
} from './archive/metadataWriter'
import { createSqliteArchiveBrowser } from './archive/archiveBrowser'
import { MirrorCoordinator } from './archive/mirror/mirrorCoordinator'
import { createFsSink } from './archive/mirror/fsSink'
import { createSpoolReader } from './archive/mirror/spoolReader'
import { buildPipeName, TelemetryPipeServer } from './telemetry/pipeServer'
import { createTelemetryLaunchPreparer } from './telemetry/telemetryLaunch'
import { SessionCoordinator } from './telemetry/sessionCoordinator'
import { UsageCoordinator } from './telemetry/usageCoordinator'
import { UsageFallbackScheduler } from './telemetry/usageFallbackScheduler'
import { PurposeDetectionCoordinator } from './telemetry/purposeDetectionCoordinator'
import { fetchFallbackUsage } from './telemetry/oauthUsageClient'
import { getUsageSettings } from './db/usageSettingsRepo'
import { resolveContainedPath } from '../shared/paths'
import { parseStatusLineMessage } from '../shared/statusline'
import {
  IpcChannels,
  isPaneIndex,
  type PaneContextUsageEvent,
  type PtyDataEvent,
  type PtyExitEvent,
  type PurposeSummary,
  type SessionArchiveErrorEvent,
  type SessionSummary,
  type UsageDisplay
} from '../shared/ipc'

const isDev = !app.isPackaged
const dirname = path.dirname(fileURLToPath(import.meta.url))

let ptyManager: PtyManager | null = null
let sessionCoordinator: SessionCoordinator | null = null
// M4: forward-referenced the same way sessionCoordinator/usageCoordinator are below -- PtyManager's
// onData/onExit callbacks and the telemetry pipe's raw-message callback are constructed before
// PurposeCoordinator itself (which depends on the already-constructed PtyManager/SessionCoordinator),
// so they read this module-level binding rather than closing over a value passed in at their own
// construction time.
let purposeCoordinator: PurposeCoordinator | null = null
// M3: assigned early in createWindow (before archiver's onEntries below ever fires for real), same
// forward-reference pattern already used for sessionCoordinator -- SessionArchiver is constructed first
// and its onEntries callback captures this module-level binding rather than a value passed in at
// construction time.
let usageCoordinator: UsageCoordinator | null = null
// M4: same forward-reference pattern as usageCoordinator above -- constructed after purposeCoordinator
// (which its onPurposeDecided callback depends on), but the archiver's onEntries callback that drives it
// is wired up earlier, so it reads this module-level binding rather than a value captured at construction
// time.
let purposeDetectionCoordinator: PurposeDetectionCoordinator | null = null
let fallbackScheduler: UsageFallbackScheduler | null = null
let archiver: SessionArchiver | null = null
let pipeServer: TelemetryPipeServer | null = null
let metadataWriter: DebouncedMetadataWriter | null = null
// M6: same forward-reference pattern as usageCoordinator/purposeDetectionCoordinator above --
// sessionArchiver's onEntries callback (which notifies the mirror of new spool bytes) is constructed
// before MirrorCoordinator itself, so it reads this module-level binding rather than a value captured at
// its own construction time.
let mirrorCoordinator: MirrorCoordinator | null = null

// M5: hoisted out of archiveDirFor below so main/archive/archiveBrowser.ts's readSession path (which
// also needs the archive root, for the exact same containment check) can share the identical computation
// rather than recomputing `path.join(app.getPath('userData'), 'archive')` a second place.
function archiveRootDir(): string {
  return path.join(app.getPath('userData'), 'archive')
}

// M2 FIX (security, defense-in-depth): resolveContainedPath verifies the joined path stays within the
// archive root, so even a session_id that somehow slipped past sessionCoordinator's isValidSessionId
// whitelist can never make this return a path outside `<userData>/archive` (path traversal).
function archiveDirFor(sessionId: string): string | null {
  return resolveContainedPath(archiveRootDir(), sessionId)
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  window.on('ready-to-show', () => window.show())

  // Open external links (e.g. from claude output) in the OS browser, never inside the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const db = getDb()

  // TD-3 AC #11: repair any `sessions` rows left open by a previous run that crashed/was force-killed.
  repairOpenSessions(db)

  const sessionArchiver = new SessionArchiver({
    onEntries: (sessionId, entries, mtimeMs) => {
      sessionCoordinator?.onJsonlEntries(sessionId, entries, mtimeMs)
      // M3 (spec §4.5): feeds the local-token-estimate window and counts as "やり取り" activity for the
      // idle-fallback scheduler. Independent of SessionCoordinator -- see usageCoordinator.ts's header
      // comment for why the two are deliberately decoupled.
      usageCoordinator?.onJsonlEntries(entries)
      // M4 (spec §4.2 "目的が空で開始した場合"): a third independent consumer of the same raw batch --
      // see purposeDetectionCoordinator.ts's header comment for why it stays decoupled from the two above.
      purposeDetectionCoordinator?.onJsonlEntries(sessionId, entries)
      // M6 (spec §4.4.1): a fourth independent consumer -- notifies the mirror that new bytes landed in
      // this session's spool transcript.jsonl copy, so it can (fire-and-forget, debounced) relay the
      // not-yet-mirrored tail to the configured output root. A no-op while unconfigured.
      mirrorCoordinator?.onTranscriptAppended(sessionId)
    },
    // M2 FIX (major): archive-sync failures must not stay console-only -- record-completeness is this
    // app's core purpose (spec §1/§4.4). Delegate to the coordinator, which knows how to resolve the
    // failing session back to a pane and push a user-visible SessionArchiveErrorEvent.
    onError: (sessionId, err) => {
      sessionCoordinator?.onArchiverError(sessionId, err)
    }
  })
  archiver = sessionArchiver

  // M2 FIX (major): debounce the metadata.json disk write instead of doing it synchronously on every
  // statusLine-triggered onSessionUpdated (which can fire on every UI render); session-close writes are
  // still immediate (see createDebouncedMetadataWriter's doc comment). before-quit flushes any remainder.
  //
  // M6: the write function is wrapped (rather than left at its default) so the mirror is notified right
  // after metadata.json is actually written to the spool -- not merely scheduled -- so it always reads the
  // latest content when it later relays a snapshot to the configured output root (spec §4.4.1).
  const sessionMetadataWriter = createDebouncedMetadataWriter(500, (archiveDir, summary) => {
    writeSessionMetadata(archiveDir, summary)
    mirrorCoordinator?.onMetadataWritten(summary.id)
  })
  metadataWriter = sessionMetadataWriter

  // M6 (spec §4.4.1, ADR-0008): the archive-output mirror. Constructed unconditionally, but every public
  // method is a documented no-op while `archive_output_root` is unset (AC "未設定ならミラー系を起動しない")
  // -- setOutputRoot(null) below arms nothing (no timers, no sink, no DB writes), so behavior is byte-for-
  // byte identical to M5 in that case.
  const mirror = new MirrorCoordinator({
    repo: createSqliteArchiveMirrorRepo(db),
    spool: createSpoolReader(archiveRootDir()),
    createSink: (destRoot) => createFsSink(destRoot),
    onStatusChanged: () => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return
      window.webContents.send(IpcChannels.archiveMirrorStatusUpdated, mirror.getStatusSummary())
    }
  })
  mirrorCoordinator = mirror
  mirror.setOutputRoot(getAppSettings(db).archiveOutputRoot)
  // ADR-0008/D-6 crash recovery: re-enqueue any row an unclean shutdown left behind. No-op while
  // unconfigured, and a fast no-op per-row when already fully caught up (see recoverOnStartup's doc
  // comment in mirrorCoordinator.ts).
  mirror.recoverOnStartup()

  const coordinator = new SessionCoordinator({
    store: createSqliteSessionStore(db),
    purposes: createSqlitePurposeStore(db),
    archiver: sessionArchiver,
    archiveDirFor,
    onSessionUpdated: (summary: SessionSummary) => {
      const archiveDir = archiveDirFor(summary.id)
      if (archiveDir) {
        sessionMetadataWriter.schedule(archiveDir, summary)
      } else {
        console.error(
          '[archive] refusing to write metadata: archive path escapes archive root',
          summary.id
        )
      }
      if (window.isDestroyed() || window.webContents.isDestroyed()) return
      window.webContents.send(IpcChannels.sessionUpdated, summary)
    },
    onArchiveError: (event: SessionArchiveErrorEvent) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return
      window.webContents.send(IpcChannels.sessionArchiveError, event)
    }
  })
  sessionCoordinator = coordinator

  // M3 (spec §4.5, AC #4/#5): idle-triggered single-shot fallback fetch. `usage` (constructed just
  // below) is referenced via the module-level `usageCoordinator` binding rather than captured directly,
  // since the fetch only ever fires several minutes later, by which point it is always assigned.
  const scheduler = new UsageFallbackScheduler({
    fetchFallback: async () => {
      const result = await fetchFallbackUsage()
      usageCoordinator?.onFallbackFetched(result)
    }
  })
  fallbackScheduler = scheduler

  const usage = new UsageCoordinator({
    onPaneContextUsage: (pane, usedPercentage, color) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return
      const payload: PaneContextUsageEvent = { pane, usedPercentage, color }
      window.webContents.send(IpcChannels.paneContextUsageUpdated, payload)
    },
    onUsageDisplay: (display: UsageDisplay) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return
      window.webContents.send(IpcChannels.usageDisplayUpdated, display)
    },
    getPlanLimitSettings: () => getUsageSettings(db),
    noteActivity: () => scheduler.noteActivity()
  })
  usageCoordinator = usage

  const pipeName = buildPipeName(String(process.pid))
  const telemetryServer = new TelemetryPipeServer(pipeName, (raw) => {
    coordinator.onRawMessage(raw)
    // M3: independent consumer of the same raw pipe message (see usageCoordinator.ts's header comment).
    usage.onRawMessage(raw)
    // M4 (TD-1 primary signal): a third independent consumer -- only the `pane` field is needed here,
    // regardless of whether the message carries enough to link a session yet (statusLine can render
    // before a transcript exists, which is exactly the "first UI paint" moment TD-1 wants to detect).
    const pane = parseStatusLineMessage(raw)?.pane
    if (pane !== null && pane !== undefined && isPaneIndex(pane)) {
      purposeCoordinator?.noteStatusLineEvent(pane)
    }
  })
  telemetryServer.start()
  pipeServer = telemetryServer

  const manager = new PtyManager({
    events: {
      onData: (pane, data) => {
        // M4 (TD-1 fallback signal): feeds the 700ms output-quiet detector regardless of whether a
        // launch is currently pending for this pane (notePtyOutput is a no-op without one).
        purposeCoordinator?.notePtyOutput(pane)
        if (window.isDestroyed() || window.webContents.isDestroyed()) return
        const payload: PtyDataEvent = { pane, data }
        window.webContents.send(IpcChannels.ptyData, payload)
      },
      onExit: (pane, exitCode, signal) => {
        coordinator.onPtyExited(pane)
        // M4: cancel any pending launch-readiness watch so it can never later try to write an initial
        // prompt to a pty that no longer exists.
        purposeCoordinator?.cancelLaunch(pane)
        if (window.isDestroyed() || window.webContents.isDestroyed()) return
        const payload: PtyExitEvent = { pane, exitCode, signal }
        window.webContents.send(IpcChannels.ptyExit, payload)
      }
    },
    getClaudePathOverride: () => getAppSettings(db).claudePath,
    prepareTelemetry: createTelemetryLaunchPreparer(pipeName)
  })
  ptyManager = manager

  const purposes = new PurposeCoordinator({
    spawnPty: (pane, cwd, extraArgs) => manager.spawn(pane, cwd, extraArgs),
    writeToPty: (pane, data) => manager.write(pane, data),
    onPaneLaunched: (pane, cwd, origin) => coordinator.onPaneLaunched(pane, cwd, origin),
    createPurpose: (pane, text) => createPurpose(db, pane, text),
    getActivePurposeForPane: (pane) => getActivePurposeForPane(db, pane),
    updatePurposeTitle: (id, title) => updatePurposeTitle(db, id, title),
    updatePurposeText: (id, text) => updatePurposeText(db, id, text),
    backfillSessionsPurposeText: (purposeId, text) => backfillPurposeText(db, purposeId, text),
    backfillSessionsTitle: (purposeId, title) => backfillPurposeTitle(db, purposeId, title),
    // M4 FIX (major, eventual-consistency): closes the metadata.json staleness window by re-running
    // sessionCoordinator's existing debounced write path for every open session under this purpose (see
    // sessionCoordinator.ts's resyncSessionsForPurpose doc comment).
    resyncSessionsForPurpose: (purposeId) => coordinator.resyncSessionsForPurpose(purposeId),
    completePurpose: (id) => completePurpose(db, id),
    generateTitle: (text) => generateTitle(text, getAppSettings(db).claudePath),
    onPurposeUpdated: (summary: PurposeSummary) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return
      window.webContents.send(IpcChannels.purposeUpdated, summary)
    }
  })
  purposeCoordinator = purposes

  // M4 (spec §4.2 "目的が空で開始した場合"): a session is "pending" a purpose-text decision only while
  // it is linked to an `active` purpose whose denormalized `sessions.purpose` copy is still the empty
  // string -- see purposeDetectionCoordinator.ts's header comment for why this is deliberately re-queried
  // from the store on every batch rather than cached.
  const purposeDetection = new PurposeDetectionCoordinator({
    getPendingPurposeId: (sessionId) => {
      const session = getSession(db, sessionId)
      if (!session || !session.purposeId || session.purpose !== '') return null
      const purpose = getPurposeById(db, session.purposeId)
      if (!purpose || purpose.status !== 'active') return null
      return purpose.id
    },
    onPurposeDecided: (purposeId, text) => purposes.decidePurposeFromFirstMessage(purposeId, text)
  })
  purposeDetectionCoordinator = purposeDetection

  // M5 (spec §4.4): read-only past-session browser. archiveRootDir() is the same root archiveDirFor
  // above resolves session archive dirs within -- readArchivedTranscript re-verifies containment against
  // it independently (defense-in-depth) before ever opening a transcript file.
  const archiveBrowser = createSqliteArchiveBrowser(db, archiveRootDir())

  registerIpcHandlers(
    window,
    db,
    manager,
    usage,
    purposes,
    archiveBrowser,
    archiveRootDir(),
    mirror
  )

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(path.join(dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Graceful shutdown (TD-3 path 3): close every open session, stop watching/listening, close pty
// processes, then the DB connection.
app.on('before-quit', () => {
  sessionCoordinator?.closeAllOpenSessions()
  // Safety net: closeAllOpenSessions() above already writes closed sessions' metadata immediately (see
  // createDebouncedMetadataWriter's doc comment), but flush here too in case any session still has a
  // pending non-final debounced write in flight.
  metadataWriter?.flushAll()
  archiver?.detachAll()
  pipeServer?.stop()
  fallbackScheduler?.stop()
  ptyManager?.killAll()
  unregisterIpcHandlers()
  closeDb()
})

// Surface otherwise-silent failures instead of dying quietly (silent failure is prohibited).
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection', reason)
})
