// Registers all cockpit:* IPC handlers. The single place where renderer requests are validated
// and dispatched to the side-effecting modules (pty, db). No business logic lives in renderer.
import { ipcMain, dialog, type BrowserWindow } from 'electron'
import type { Database } from 'better-sqlite3'
import {
  IpcChannels,
  isPaneIndex,
  type PtyWriteRequest,
  type PtyResizeRequest,
  type PtyKillRequest,
  type PaneSetting,
  type SetPaneCwdRequest,
  type ChooseFolderResult,
  type AppSettings,
  type SetClaudePathRequest,
  type ClaudeResolveStatus,
  type PurposeSummary,
  type PlanPreset,
  type SetUsageSettingsRequest,
  type UsageSettings,
  type PaneLaunchStartRequest,
  type PaneLaunchStartResult,
  type PaneLaunchResumeRequest,
  type PaneLaunchResumeResult,
  type CompletePurposeRequest,
  type ConfirmCwdChangeResult,
  type ArchiveListSessionsRequest,
  type ArchiveSessionListItem,
  type ArchiveReadSessionRequest,
  type ArchiveReadSessionResult,
  type SetArchiveOutputRootRequest,
  type SetArchiveOutputRootResult,
  type MirrorStatusSummary,
  type BackfillProgressEvent
} from '../../shared/ipc'
import { PtyManager } from '../pty/ptyManager'
import { resolveClaude, ClaudeResolutionError } from '../pty/resolveClaude'
import type { PurposeCoordinator } from '../pty/purposeCoordinator'
import { getAllPaneSettings, setPaneCwd } from '../db/paneSettingsRepo'
import { getAppSettings, setClaudePath, setArchiveOutputRoot } from '../db/appSettingsRepo'
import { getAllActivePurposes } from '../db/purposeRepo'
import { getUsageSettings, setUsageSettings } from '../db/usageSettingsRepo'
import type { UsageCoordinator } from '../telemetry/usageCoordinator'
import type { ArchiveBrowserPort } from '../archive/archiveBrowser'
import type { MirrorControlPort } from '../archive/mirror/mirrorCoordinator'
import { probeWritable } from '../archive/mirror/fsSink'
import { validateMirrorRoot } from '../../shared/mirrorPlan'

function assertPane(pane: unknown): asserts pane is 0 | 1 | 2 | 3 {
  if (typeof pane !== 'number' || !isPaneIndex(pane)) {
    throw new Error(`Invalid pane index: ${String(pane)}`)
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${field}: expected a non-empty string`)
  }
}

/** M4 (spec §4.2 "目的テキストの入力は任意"): purposeText may legitimately be empty (the "目的が空で
 * 開始した場合" flow) -- only the type is validated here, unlike cwd/pane which must be non-empty. */
function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${field}: expected a string`)
  }
}

const VALID_PLAN_PRESETS: readonly PlanPreset[] = ['pro', 'max5x', 'max20x', 'custom']

/** M3 IPC input validation (mirrors assertPane/assertNonEmptyString's style above): a renderer-sourced
 * plan-limit settings payload must have a known preset and null-or-positive-finite custom overrides
 * before it is ever written to app_settings. */
function assertUsageSettings(value: unknown): asserts value is SetUsageSettingsRequest {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid usage settings payload')
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.preset !== 'string' ||
    !(VALID_PLAN_PRESETS as readonly string[]).includes(record.preset)
  ) {
    throw new Error(`Invalid plan preset: ${String(record.preset)}`)
  }
  for (const key of ['customFiveHourTokens', 'customWeeklyTokens'] as const) {
    const v = record[key]
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
      throw new Error(`Invalid ${key}: must be null or a positive number`)
    }
  }
}

/** M5 (spec §4.4): input validation for the past-session search request, mirroring
 * assertUsageSettings's style above. `searchText` must be a string (empty is valid, meaning "no
 * filter"); `limit`/`offset`, if present, must be sane pagination integers. */
function assertArchiveListSessionsRequest(
  value: unknown
): asserts value is ArchiveListSessionsRequest {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid archive list sessions request')
  }
  const record = value as Record<string, unknown>
  if (typeof record.searchText !== 'string') {
    throw new Error('Invalid searchText: expected a string')
  }
  if (
    record.limit !== undefined &&
    (typeof record.limit !== 'number' || !Number.isInteger(record.limit) || record.limit <= 0)
  ) {
    throw new Error('Invalid limit: must be a positive integer')
  }
  if (
    record.offset !== undefined &&
    (typeof record.offset !== 'number' || !Number.isInteger(record.offset) || record.offset < 0)
  ) {
    throw new Error('Invalid offset: must be a non-negative integer')
  }
}

export function registerIpcHandlers(
  window: BrowserWindow,
  db: Database,
  ptyManager: PtyManager,
  usageCoordinator: UsageCoordinator,
  purposeCoordinator: PurposeCoordinator,
  archiveBrowser: ArchiveBrowserPort,
  /** M6: the spool root (userData/archive) -- used only to validate a candidate output root never
   * resolves to the spool itself or a path underneath it (ADR-0008/D-5 self-mirror prevention). */
  spoolRoot: string,
  mirrorControl: MirrorControlPort
): void {
  ipcMain.handle(IpcChannels.ptyWrite, (_event, req: PtyWriteRequest): void => {
    assertPane(req.pane)
    if (typeof req.data !== 'string') {
      throw new Error('Invalid pty write payload: data must be a string')
    }
    ptyManager.write(req.pane, req.data)
  })

  ipcMain.handle(IpcChannels.ptyResize, (_event, req: PtyResizeRequest): void => {
    assertPane(req.pane)
    if (
      !Number.isInteger(req.cols) ||
      !Number.isInteger(req.rows) ||
      req.cols <= 0 ||
      req.rows <= 0
    ) {
      throw new Error(`Invalid resize dimensions: ${req.cols}x${req.rows}`)
    }
    ptyManager.resize(req.pane, req.cols, req.rows)
  })

  ipcMain.handle(IpcChannels.ptyKill, (_event, req: PtyKillRequest): void => {
    assertPane(req.pane)
    ptyManager.kill(req.pane)
  })

  ipcMain.handle(IpcChannels.paneSettingsGetAll, (): PaneSetting[] => {
    return getAllPaneSettings(db)
  })

  ipcMain.handle(IpcChannels.paneSettingsSetCwd, (_event, req: SetPaneCwdRequest): void => {
    assertPane(req.pane)
    assertNonEmptyString(req.cwd, 'cwd')
    setPaneCwd(db, req.pane, req.cwd)
  })

  ipcMain.handle(IpcChannels.paneSettingsChooseFolder, async (): Promise<ChooseFolderResult> => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: null }
    }
    return { canceled: false, path: result.filePaths[0] }
  })

  ipcMain.handle(IpcChannels.appSettingsGet, (): AppSettings => {
    return getAppSettings(db)
  })

  ipcMain.handle(
    IpcChannels.appSettingsSetClaudePath,
    (_event, req: SetClaudePathRequest): void => {
      assertNonEmptyString(req.claudePath, 'claudePath')
      setClaudePath(db, req.claudePath)
    }
  )

  ipcMain.handle(IpcChannels.claudeResolveStatus, (): ClaudeResolveStatus => {
    const override = getAppSettings(db).claudePath
    try {
      const resolution = resolveClaude(override)
      return { resolved: true, path: resolution.path, kind: resolution.kind }
    } catch (err) {
      const reason = err instanceof ClaudeResolutionError ? err.message : String(err)
      return { resolved: false, reason }
    }
  })

  // M3 (spec §4.5 "手動調整可"): plan-limit preset/custom overrides for the estimated-fallback display.
  ipcMain.handle(IpcChannels.usageSettingsGet, (): UsageSettings => {
    return getUsageSettings(db)
  })

  ipcMain.handle(IpcChannels.usageSettingsSet, (_event, req: SetUsageSettingsRequest): void => {
    assertUsageSettings(req)
    setUsageSettings(db, req)
    // Recompute+push immediately so a settings change is visibly reflected right away rather than
    // waiting for the next statusLine/JSONL-driven refresh (spec §4.5's "更新はやり取り発生ごとに即時"
    // is about usage *data* changes; a settings change is a distinct trigger this exists to cover).
    usageCoordinator.refreshDisplay()
  })

  // ---- M4: purpose lifecycle + launch flow (spec §4.2/§4.6, TD-1/TD-7) ----

  ipcMain.handle(
    IpcChannels.paneLaunchStart,
    (_event, req: PaneLaunchStartRequest): PaneLaunchStartResult => {
      assertPane(req.pane)
      assertNonEmptyString(req.cwd, 'cwd')
      assertString(req.purposeText, 'purposeText')
      // M4 FIX iter3 (code #5): the renderer normally can't reach this (the "＋ 新規セッション" button
      // is hidden while `running` is true, see Pane.tsx), but PtyManager.spawn()'s implicit kill-and-
      // replace of an already-running pty would otherwise let a stray/duplicate call here silently
      // orphan the current session's purpose row (its `ended_at` never gets set because the pty is
      // killed out from under it rather than exiting on its own). Guard it here too, at the Main-side
      // boundary, rather than relying solely on the renderer never sending this.
      if (ptyManager.isRunning(req.pane)) {
        throw new Error(
          `Pane ${req.pane} already has a running claude process; stop it before starting a new session`
        )
      }
      return purposeCoordinator.startNewSession(req.pane, req.cwd, req.purposeText)
    }
  )

  ipcMain.handle(
    IpcChannels.paneLaunchResume,
    (_event, req: PaneLaunchResumeRequest): PaneLaunchResumeResult => {
      assertPane(req.pane)
      assertNonEmptyString(req.cwd, 'cwd')
      // M4 FIX iter3 (code #5): symmetric with paneLaunchStart above -- "再開" (TD-7) is only ever
      // meaningful when no pty is currently running for the pane (Pane.tsx only renders the resume
      // overlay/button while `!running`); reject rather than let PtyManager.spawn() implicitly kill an
      // already-running process.
      if (ptyManager.isRunning(req.pane)) {
        throw new Error(
          `Pane ${req.pane} already has a running claude process; stop it before resuming`
        )
      }
      return purposeCoordinator.resumeSession(req.pane, req.cwd)
    }
  )

  ipcMain.handle(IpcChannels.purposeGetActiveForAllPanes, (): PurposeSummary[] => {
    return getAllActivePurposes(db)
  })

  ipcMain.handle(
    IpcChannels.purposeComplete,
    (_event, req: CompletePurposeRequest): PurposeSummary => {
      assertNonEmptyString(req.purposeId, 'purposeId')
      return purposeCoordinator.completePurpose(req.purposeId)
    }
  )

  // TD-7: `--continue` assumes a fixed cwd for the purpose's lifetime -- warn (via a native message
  // box, consistent with paneSettingsChooseFolder's use of dialog.showOpenDialog above) before the
  // renderer proceeds with an actual folder change for a pane that has an active purpose.
  ipcMain.handle(
    IpcChannels.paneSettingsConfirmActivePurposeCwdChange,
    async (): Promise<ConfirmCwdChangeResult> => {
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        buttons: ['変更する', 'キャンセル'],
        defaultId: 1,
        cancelId: 1,
        message: 'このペインには進行中の目的があります',
        detail:
          'claude の --continue は起動時の cwd を前提に直前の会話を復元します。' +
          'デフォルトフォルダを変更すると、この目的の「再開」ボタンで前回の会話を復元できなくなる可能性があります。'
      })
      return { confirmed: result.response === 0 }
    }
  )

  // ---- M5: read-only past-session browsing (spec §4.4). No write/delete channel exists for archive
  // data anywhere in this app -- these two handlers are the entire archive-facing IPC surface. ----

  ipcMain.handle(
    IpcChannels.archiveListSessions,
    (_event, req: ArchiveListSessionsRequest): ArchiveSessionListItem[] => {
      assertArchiveListSessionsRequest(req)
      return archiveBrowser.listSessions(req)
    }
  )

  ipcMain.handle(
    IpcChannels.archiveReadSession,
    async (_event, req: ArchiveReadSessionRequest): Promise<ArchiveReadSessionResult> => {
      assertNonEmptyString(req.sessionId, 'sessionId')
      return archiveBrowser.readSession(req.sessionId)
    }
  )

  // ---- M6: archive output-destination mirroring (spec §4.4.1, ADR-0008) ----

  ipcMain.handle(
    IpcChannels.archiveOutputRootChooseFolder,
    async (): Promise<ChooseFolderResult> => {
      const result = await dialog.showOpenDialog(window, {
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, path: null }
      }
      return { canceled: false, path: result.filePaths[0] }
    }
  )

  // D-5: "出力先はプローブ（一時ファイル作成→削除）で検証" -- validated in two steps before ever
  // persisting/activating a new root: (1) the pure self-mirror-containment check (never inside the
  // spool), then (2) an effectful write probe. `root: null` clears the setting and always succeeds (spec
  // §4.4.1 "解除" -- clearing never needs to write-probe anything).
  ipcMain.handle(
    IpcChannels.archiveOutputRootSet,
    async (_event, req: SetArchiveOutputRootRequest): Promise<SetArchiveOutputRootResult> => {
      if (req.root === null) {
        setArchiveOutputRoot(db, null)
        mirrorControl.setOutputRoot(null)
        return { ok: true }
      }
      assertNonEmptyString(req.root, 'root')
      const validation = validateMirrorRoot(spoolRoot, req.root)
      if (!validation.ok) return { ok: false, reason: validation.reason }
      const probe = await probeWritable(req.root)
      if (!probe.ok) return { ok: false, reason: probe.reason }
      setArchiveOutputRoot(db, req.root)
      mirrorControl.setOutputRoot(req.root)
      return { ok: true }
    }
  )

  ipcMain.handle(IpcChannels.archiveMirrorStatusGet, (): MirrorStatusSummary => {
    return mirrorControl.getStatusSummary()
  })

  // D-4 "自動実行しない": only ever runs when the renderer explicitly invokes it. Progress is streamed
  // back over `archiveBackfillProgress` (D-5: never leave a long-running operation unaccounted-for).
  ipcMain.handle(IpcChannels.archiveBackfillStart, async (): Promise<void> => {
    await mirrorControl.startBackfill((event: BackfillProgressEvent) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return
      window.webContents.send(IpcChannels.archiveBackfillProgress, event)
    })
  })
}

export function unregisterIpcHandlers(): void {
  for (const channel of Object.values(IpcChannels)) {
    ipcMain.removeHandler(channel)
  }
}
