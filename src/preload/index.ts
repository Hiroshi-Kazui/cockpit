// Preload script: the only bridge between the isolated renderer and Node/Electron APIs.
// Exposes a minimal, typed surface via contextBridge — renderer never touches ipcRenderer directly.
import { contextBridge, ipcRenderer } from 'electron'
import {
  IpcChannels,
  type PtyWriteRequest,
  type PtyResizeRequest,
  type PtyKillRequest,
  type PtyDataEvent,
  type PtyExitEvent,
  type PaneSetting,
  type SetPaneCwdRequest,
  type ChooseFolderResult,
  type AppSettings,
  type SetClaudePathRequest,
  type SetLayoutModeRequest,
  type ClaudeResolveStatus,
  type SessionSummary,
  type SessionArchiveErrorEvent,
  type PurposeSummary,
  type PaneContextUsageEvent,
  type SetUsageSettingsRequest,
  type UsageDisplay,
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
  type BackfillProgressEvent,
  type SetEvaluationEnabledRequest,
  type SetEvaluationModelRequest,
  type SetEvaluationOutputRootRequest,
  type SetEvaluationOutputRootResult,
  type EvaluationGetForPurposeRequest,
  type EvaluationRerunRequest,
  type EvaluationSummary,
  type EvaluationHistoryEntry
} from '../shared/ipc'

export interface CockpitApi {
  pty: {
    write: (req: PtyWriteRequest) => Promise<void>
    resize: (req: PtyResizeRequest) => Promise<void>
    kill: (req: PtyKillRequest) => Promise<void>
    onData: (listener: (event: PtyDataEvent) => void) => () => void
    onExit: (listener: (event: PtyExitEvent) => void) => () => void
  }
  paneSettings: {
    getAll: () => Promise<PaneSetting[]>
    setCwd: (req: SetPaneCwdRequest) => Promise<void>
    chooseFolder: () => Promise<ChooseFolderResult>
    /** TD-7: native confirm shown before changing a pane's folder while it has an active purpose. */
    confirmActivePurposeCwdChange: () => Promise<ConfirmCwdChangeResult>
  }
  appSettings: {
    get: () => Promise<AppSettings>
    setClaudePath: (req: SetClaudePathRequest) => Promise<void>
    setLayoutMode: (req: SetLayoutModeRequest) => Promise<void>
  }
  claude: {
    resolveStatus: () => Promise<ClaudeResolveStatus>
  }
  session: {
    onUpdated: (listener: (summary: SessionSummary) => void) => () => void
    onArchiveError: (listener: (event: SessionArchiveErrorEvent) => void) => () => void
  }
  purpose: {
    getActiveForAllPanes: () => Promise<PurposeSummary[]>
    complete: (req: CompletePurposeRequest) => Promise<PurposeSummary>
    onUpdated: (listener: (summary: PurposeSummary) => void) => () => void
  }
  /** M4: launch orchestration (spec §4.2 dialog-confirm flow, §4.6/TD-7 one-click "再開"). */
  paneLaunch: {
    start: (req: PaneLaunchStartRequest) => Promise<PaneLaunchStartResult>
    resume: (req: PaneLaunchResumeRequest) => Promise<PaneLaunchResumeResult>
  }
  usage: {
    onPaneContextUpdated: (listener: (event: PaneContextUsageEvent) => void) => () => void
    onDisplayUpdated: (listener: (display: UsageDisplay) => void) => () => void
    getSettings: () => Promise<UsageSettings>
    setSettings: (req: SetUsageSettingsRequest) => Promise<void>
  }
  /** M5 (spec §4.4): read-only past-session browsing. No write/delete method exists here -- the archive
   * is append-only and this app never exposes an edit/delete UI for it (AC).
   *
   * M6 (spec §4.4.1, ADR-0008) adds output-destination mirroring controls below -- still no edit/delete
   * of archived *content* itself, only where the (already read-only) archive is additionally mirrored to. */
  archive: {
    listSessions: (req: ArchiveListSessionsRequest) => Promise<ArchiveSessionListItem[]>
    readSession: (req: ArchiveReadSessionRequest) => Promise<ArchiveReadSessionResult>
    chooseOutputRootFolder: () => Promise<ChooseFolderResult>
    setOutputRoot: (req: SetArchiveOutputRootRequest) => Promise<SetArchiveOutputRootResult>
    getMirrorStatus: () => Promise<MirrorStatusSummary>
    onMirrorStatusUpdated: (listener: (summary: MirrorStatusSummary) => void) => () => void
    startBackfill: () => Promise<void>
    onBackfillProgress: (listener: (event: BackfillProgressEvent) => void) => () => void
  }
  /** M9 (spec §2/§4.6 deferred "事後分析", ADR-0010): purpose-completion evaluation. Read-only + one
   * explicit re-run action -- there is no create/edit/delete channel here either (an evaluation row only
   * ever comes into existence via completePurpose's server-side trigger or this rerun call). */
  evaluation: {
    getForPurpose: (req: EvaluationGetForPurposeRequest) => Promise<EvaluationSummary | null>
    listAll: () => Promise<EvaluationHistoryEntry[]>
    rerun: (req: EvaluationRerunRequest) => Promise<void>
    onUpdated: (listener: (summary: EvaluationSummary) => void) => () => void
    chooseOutputRootFolder: () => Promise<ChooseFolderResult>
    setOutputRoot: (req: SetEvaluationOutputRootRequest) => Promise<SetEvaluationOutputRootResult>
    setEnabled: (req: SetEvaluationEnabledRequest) => Promise<void>
    setModel: (req: SetEvaluationModelRequest) => Promise<void>
  }
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: CockpitApi = {
  pty: {
    write: (req) => ipcRenderer.invoke(IpcChannels.ptyWrite, req),
    resize: (req) => ipcRenderer.invoke(IpcChannels.ptyResize, req),
    kill: (req) => ipcRenderer.invoke(IpcChannels.ptyKill, req),
    onData: (listener) => subscribe<PtyDataEvent>(IpcChannels.ptyData, listener),
    onExit: (listener) => subscribe<PtyExitEvent>(IpcChannels.ptyExit, listener)
  },
  paneSettings: {
    getAll: () => ipcRenderer.invoke(IpcChannels.paneSettingsGetAll),
    setCwd: (req) => ipcRenderer.invoke(IpcChannels.paneSettingsSetCwd, req),
    chooseFolder: () => ipcRenderer.invoke(IpcChannels.paneSettingsChooseFolder),
    confirmActivePurposeCwdChange: () =>
      ipcRenderer.invoke(IpcChannels.paneSettingsConfirmActivePurposeCwdChange)
  },
  appSettings: {
    get: () => ipcRenderer.invoke(IpcChannels.appSettingsGet),
    setClaudePath: (req) => ipcRenderer.invoke(IpcChannels.appSettingsSetClaudePath, req),
    setLayoutMode: (req) => ipcRenderer.invoke(IpcChannels.appSettingsSetLayoutMode, req)
  },
  claude: {
    resolveStatus: () => ipcRenderer.invoke(IpcChannels.claudeResolveStatus)
  },
  session: {
    onUpdated: (listener) => subscribe<SessionSummary>(IpcChannels.sessionUpdated, listener),
    onArchiveError: (listener) =>
      subscribe<SessionArchiveErrorEvent>(IpcChannels.sessionArchiveError, listener)
  },
  purpose: {
    getActiveForAllPanes: () => ipcRenderer.invoke(IpcChannels.purposeGetActiveForAllPanes),
    complete: (req) => ipcRenderer.invoke(IpcChannels.purposeComplete, req),
    onUpdated: (listener) => subscribe<PurposeSummary>(IpcChannels.purposeUpdated, listener)
  },
  paneLaunch: {
    start: (req) => ipcRenderer.invoke(IpcChannels.paneLaunchStart, req),
    resume: (req) => ipcRenderer.invoke(IpcChannels.paneLaunchResume, req)
  },
  usage: {
    onPaneContextUpdated: (listener) =>
      subscribe<PaneContextUsageEvent>(IpcChannels.paneContextUsageUpdated, listener),
    onDisplayUpdated: (listener) =>
      subscribe<UsageDisplay>(IpcChannels.usageDisplayUpdated, listener),
    getSettings: () => ipcRenderer.invoke(IpcChannels.usageSettingsGet),
    setSettings: (req) => ipcRenderer.invoke(IpcChannels.usageSettingsSet, req)
  },
  archive: {
    listSessions: (req) => ipcRenderer.invoke(IpcChannels.archiveListSessions, req),
    readSession: (req) => ipcRenderer.invoke(IpcChannels.archiveReadSession, req),
    chooseOutputRootFolder: () => ipcRenderer.invoke(IpcChannels.archiveOutputRootChooseFolder),
    setOutputRoot: (req) => ipcRenderer.invoke(IpcChannels.archiveOutputRootSet, req),
    getMirrorStatus: () => ipcRenderer.invoke(IpcChannels.archiveMirrorStatusGet),
    onMirrorStatusUpdated: (listener) =>
      subscribe<MirrorStatusSummary>(IpcChannels.archiveMirrorStatusUpdated, listener),
    startBackfill: () => ipcRenderer.invoke(IpcChannels.archiveBackfillStart),
    onBackfillProgress: (listener) =>
      subscribe<BackfillProgressEvent>(IpcChannels.archiveBackfillProgress, listener)
  },
  evaluation: {
    getForPurpose: (req) => ipcRenderer.invoke(IpcChannels.evaluationGetForPurpose, req),
    listAll: () => ipcRenderer.invoke(IpcChannels.evaluationListAll),
    rerun: (req) => ipcRenderer.invoke(IpcChannels.evaluationRerun, req),
    onUpdated: (listener) => subscribe<EvaluationSummary>(IpcChannels.evaluationUpdated, listener),
    chooseOutputRootFolder: () => ipcRenderer.invoke(IpcChannels.evaluationOutputRootChooseFolder),
    setOutputRoot: (req) => ipcRenderer.invoke(IpcChannels.evaluationOutputRootSet, req),
    setEnabled: (req) => ipcRenderer.invoke(IpcChannels.appSettingsSetEvaluationEnabled, req),
    setModel: (req) => ipcRenderer.invoke(IpcChannels.appSettingsSetEvaluationModel, req)
  }
}

contextBridge.exposeInMainWorld('cockpit', api)
