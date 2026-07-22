// Type-safe IPC contract shared by main, preload, and renderer processes (TD-6: cockpit:<domain>:<verb>).
import type { JsonlDisplayTurn } from './jsonl'
import type { LayoutMode } from './layout'
import type { EvaluationInputStats, EvaluationSuggestion } from './evaluation'
import type {
  EvaluationAxisAverages,
  EvaluationBucket,
  EvaluationHistoryEntry,
  EvaluationOverallSummary
} from './evaluationAggregate'

export type {
  EvaluationInputStats,
  EvaluationSuggestion,
  EvaluationAxisAverages,
  EvaluationBucket,
  EvaluationHistoryEntry,
  EvaluationOverallSummary
}

/** Valid pane slot indices for the 4-pane grid (spec §4.1). */
export type PaneIndex = 0 | 1 | 2 | 3

export const PANE_INDICES: readonly PaneIndex[] = [0, 1, 2, 3]

export function isPaneIndex(value: number): value is PaneIndex {
  return value === 0 || value === 1 || value === 2 || value === 3
}

/** Runtime guard for the several `row.pane as PaneIndex` call sites (archiveBrowser.ts, purposeRepo.ts,
 * sessionCoordinator.ts's toSummary/onArchiverError) that narrow a DB `INTEGER` column into the domain
 * `PaneIndex` type. Throws rather than silently clamping/defaulting an out-of-range value (CLAUDE.md:
 * silent failure prohibited) -- in normal operation this can never actually be out of range, since every
 * row is only ever created with an already-`isPaneIndex`-validated value (see e.g.
 * sessionCoordinator.ts's onRawMessage), so a throw here would only ever surface a genuine data-integrity
 * bug (hand-edited DB row, schema drift), not a reachable user-facing failure mode. */
export function toPaneIndex(value: number): PaneIndex {
  if (!isPaneIndex(value)) {
    throw new RangeError(`invalid pane index: ${value}`)
  }
  return value
}

/** IPC channel names. Invoke channels are renderer -> main request/response; event channels are main -> renderer push. */
export const IpcChannels = {
  ptyWrite: 'cockpit:pty:write',
  ptyResize: 'cockpit:pty:resize',
  ptyKill: 'cockpit:pty:kill',
  ptyData: 'cockpit:pty:data',
  ptyExit: 'cockpit:pty:exit',
  paneSettingsGetAll: 'cockpit:paneSettings:getAll',
  paneSettingsSetCwd: 'cockpit:paneSettings:setCwd',
  paneSettingsChooseFolder: 'cockpit:paneSettings:chooseFolder',
  appSettingsGet: 'cockpit:appSettings:get',
  appSettingsSetClaudePath: 'cockpit:appSettings:setClaudePath',
  appSettingsSetLayoutMode: 'cockpit:appSettings:setLayoutMode',
  claudeResolveStatus: 'cockpit:claude:resolveStatus',
  sessionUpdated: 'cockpit:session:updated',
  sessionArchiveError: 'cockpit:session:archiveError',
  paneContextUsageUpdated: 'cockpit:usage:paneContextUpdated',
  usageDisplayUpdated: 'cockpit:usage:displayUpdated',
  usageSettingsGet: 'cockpit:usage:settingsGet',
  usageSettingsSet: 'cockpit:usage:settingsSet',
  // ---- M4: purpose lifecycle + launch flow (spec §4.2/§4.6, TD-1/TD-7) ----
  paneLaunchStart: 'cockpit:paneLaunch:start',
  paneLaunchResume: 'cockpit:paneLaunch:resume',
  purposeGetActiveForAllPanes: 'cockpit:purpose:getActiveForAllPanes',
  purposeComplete: 'cockpit:purpose:complete',
  purposeUpdated: 'cockpit:purpose:updated',
  paneSettingsConfirmActivePurposeCwdChange: 'cockpit:paneSettings:confirmActivePurposeCwdChange',
  // ---- M5: read-only past-session browsing (spec §4.4) ----
  archiveListSessions: 'cockpit:archive:listSessions',
  archiveReadSession: 'cockpit:archive:readSession',
  // ---- M6: archive output-destination mirroring (spec §4.4.1, ADR-0008) ----
  archiveOutputRootChooseFolder: 'cockpit:archive:chooseOutputRootFolder',
  archiveOutputRootSet: 'cockpit:archive:set-output-root',
  archiveMirrorStatusGet: 'cockpit:archive:mirror-status',
  archiveMirrorStatusUpdated: 'cockpit:archive:mirrorStatusUpdated',
  archiveBackfillStart: 'cockpit:archive:backfill',
  archiveBackfillProgress: 'cockpit:archive:backfillProgress',
  // ---- M9: purpose-completion evaluation (spec §2/§4.6 deferred "事後分析", ADR-0010) ----
  appSettingsSetEvaluationEnabled: 'cockpit:appSettings:setEvaluationEnabled',
  appSettingsSetEvaluationModel: 'cockpit:appSettings:setEvaluationModel',
  evaluationOutputRootChooseFolder: 'cockpit:evaluation:chooseOutputRootFolder',
  evaluationOutputRootSet: 'cockpit:evaluation:setOutputRoot',
  evaluationGetForPurpose: 'cockpit:evaluation:getForPurpose',
  evaluationListAll: 'cockpit:evaluation:listAll',
  evaluationRerun: 'cockpit:evaluation:rerun',
  evaluationUpdated: 'cockpit:evaluation:updated'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

// ---- pty ----

export interface PtyWriteRequest {
  pane: PaneIndex
  data: string
}

export interface PtyResizeRequest {
  pane: PaneIndex
  cols: number
  rows: number
}

export interface PtyKillRequest {
  pane: PaneIndex
}

/** Pushed main -> renderer whenever the pty produces output. Raw passthrough, no interpretation (spec §4.1). */
export interface PtyDataEvent {
  pane: PaneIndex
  data: string
}

/** Pushed main -> renderer when the pty process exits (spec §5 origin for session close, TD-3). */
export interface PtyExitEvent {
  pane: PaneIndex
  exitCode: number
  signal: number | undefined
}

// ---- pane settings ----

export interface PaneSetting {
  pane: PaneIndex
  defaultCwd: string | null
}

export interface SetPaneCwdRequest {
  pane: PaneIndex
  cwd: string
}

export interface ChooseFolderResult {
  canceled: boolean
  path: string | null
}

// ---- app settings ----

export interface AppSettings {
  claudePath: string | null
  /** M6 (spec §4.4.1, ADR-0008): configured archive-output (mirror) destination root, or null when
   * mirroring is not configured -- in which case behavior is byte-for-byte identical to M5 (no mirror
   * engine runs at all, main/index.ts). */
  archiveOutputRoot: string | null
  /** Persisted pane split layout (spec §4.1), restored on next launch so the window reopens with the
   * split the user last left it in. Defaults to 'single' when never set / stored value is unrecognized. */
  layoutMode: LayoutMode
  /** M9 (ADR-0010 D-2): master on/off switch for the purpose-completion evaluation pipeline. Defaults to
   * true (ON) -- when false, `completePurpose` behaves byte-for-byte as it did before M9 (no evaluation
   * row is ever created). */
  evaluationEnabled: boolean
  /** M9 (ADR-0010 D-2): model passed to the headless `claude -p --model <model>` evaluation one-shot.
   * Defaults to 'haiku' (same economy-first default as titleGenerator). */
  evaluationModel: string
  /** M9 (ADR-0010 D-5): optional output-destination folder for the evaluation report (Markdown+JSON),
   * independent of the archive-output mirror root above. `null` means app-internal display only. */
  evaluationOutputRoot: string | null
}

export interface SetClaudePathRequest {
  claudePath: string
}

export interface SetLayoutModeRequest {
  layoutMode: LayoutMode
}

// ---- claude resolution status (AC #9: user-visible error, no silent failure) ----

export type ClaudeResolveStatus =
  { resolved: true; path: string; kind: 'exe' | 'cmd' } | { resolved: false; reason: string }

// ---- sessions (M2 spec §5, TD-2, TD-3) ----

/** How a `sessions` row came into existence (TD-2). 'restart' is the M4 one-click-resume path (TD-7). */
export type SessionOrigin = 'dialog' | 'clear' | 'resume' | 'restart'

/** DTO pushed main -> renderer whenever a session row is created/updated/closed (spec §5). */
export interface SessionSummary {
  id: string
  pane: PaneIndex
  purposeId: string | null
  origin: SessionOrigin
  purpose: string | null
  title: string | null
  cwd: string | null
  startedAt: number
  endedAt: number | null
  model: string | null
  tokensIn: number
  tokensOut: number
  tokensCacheRead: number
  tokensCacheWrite: number
}

/** Pushed main -> renderer when the archiver fails to sync a session's transcript into the archive
 * (read error, source shrank, disk full, etc. -- spec §1/§4.4: record-completeness is the app's core
 * purpose, so this must be visible, not console-only, M2 FIX). `pane` is null if the failing session
 * could not be looked up (should not normally happen). */
export interface SessionArchiveErrorEvent {
  sessionId: string
  pane: PaneIndex | null
  message: string
}

// ---- purposes (spec §5). Created only via the M4 launch flow below (paneLaunchStart); there is no
// standalone "create purpose" IPC entrypoint -- a purpose row only ever comes into existence alongside
// a pty spawn (PurposeCoordinator.startNewSession), so the two can never drift out of sync (spec §4.2,
// TD-7). ----

export interface PurposeSummary {
  id: string
  pane: PaneIndex
  text: string
  title: string | null
  status: 'active' | 'completed'
  createdAt: number
  completedAt: number | null
}

// ---- M4: launch flow (spec §4.2, TD-1) and purpose lifecycle (spec §4.6, TD-7) ----

/** Renderer -> main: dialog confirmed with fresh purpose text. Main atomically creates the `purposes`
 * row, spawns the pty, arms the TD-1 launch-readiness watcher (which sends `purposeText` as the first
 * prompt once ready), and kicks off async title generation -- see main/pty/purposeCoordinator.ts. */
export interface PaneLaunchStartRequest {
  pane: PaneIndex
  cwd: string
  purposeText: string
}

export interface PaneLaunchStartResult {
  pid: number
  purposeId: string
}

/** Renderer -> main: "再開" button pressed for a pane with an active purpose but no running pty
 * (TD-7). Spawns claude with `--continue` in the same cwd; no initial prompt is sent (the prior
 * conversation is restored by claude itself) and no title generation is triggered (the purpose already
 * has one). */
export interface PaneLaunchResumeRequest {
  pane: PaneIndex
  cwd: string
}

export interface PaneLaunchResumeResult {
  pid: number
}

export interface CompletePurposeRequest {
  purposeId: string
}

/** Result of the native confirm dialog shown before changing a pane's default folder while it has an
 * active purpose (TD-7: `--continue` assumes a fixed cwd for the purpose's lifetime). */
export interface ConfirmCwdChangeResult {
  confirmed: boolean
}

// ---- usage / context gauge / rate limits (M3, spec §4.5). Value/calc types (context-gauge color,
// per-window measured-vs-estimated display shape, plan-limit settings) are defined once in
// shared/usage.ts -- the pure-calculation module -- and re-exported here (renamed where the IPC-facing
// name differs) so this file stays the single IPC contract entrypoint (CLAUDE.md: "channel 名と payload
// 型を1箇所で定義") without hand-duplicating an identical shape in two places. ----
import type {
  ContextGaugeColor,
  PlanLimitSettings,
  PlanPreset,
  RateLimitWindowDisplay,
  UsageDisplay,
  UsageSource
} from './usage'

export type { ContextGaugeColor, PlanPreset, RateLimitWindowDisplay, UsageDisplay, UsageSource }

/** Pushed main -> renderer whenever a pane's statusLine carries a context-window usage reading (spec
 * §4.5: updates "やり取りのたびに"). */
export interface PaneContextUsageEvent {
  pane: PaneIndex
  usedPercentage: number
  color: ContextGaugeColor
}

/** The plan-limit preset + optional manual overrides used to seed the "推定" fallback (spec §4.5
 * "手動調整可"). Structurally identical to shared/usage.ts's PlanLimitSettings -- aliased under the more
 * IPC-appropriate name rather than redeclared. */
export type UsageSettings = PlanLimitSettings

export type SetUsageSettingsRequest = UsageSettings

// ---- M5: read-only past-session browsing (spec §4.4). This is the *only* archive-facing IPC surface --
// there is deliberately no create/update/delete channel here: the renderer can list and read, nothing
// else (AC "閲覧は読み取り専用。アーカイブへの編集・削除UIが存在しない"). ----

/** Renderer -> main: list/search past sessions from the SQLite index. `searchText` is matched
 * case-insensitively against purpose/title/cwd (main/db/sessionRepo.ts); an empty string matches every
 * session. `limit`/`offset` are optional pagination (defaults applied main-side). */
export interface ArchiveListSessionsRequest {
  searchText: string
  limit?: number
  offset?: number
}

/** One row of the past-session list (spec §4.4's SQLite index fields, minus `jsonl_path` -- the renderer
 * never needs the raw archive path, only the session id to request its transcript via
 * archiveReadSession). */
export interface ArchiveSessionListItem {
  id: string
  pane: PaneIndex
  purpose: string | null
  title: string | null
  cwd: string | null
  startedAt: number
  endedAt: number | null
  model: string | null
  tokensIn: number
  tokensOut: number
  tokensCacheRead: number
  tokensCacheWrite: number
}

/** Renderer -> main: read one session's archived transcript for the viewer. */
export interface ArchiveReadSessionRequest {
  sessionId: string
}

/** One user/assistant turn extracted from the archived transcript (main/archive/archiveReader.ts, backed
 * by shared/jsonl.ts's parseJsonlLineForDisplay). Aliased under the IPC-facing name rather than
 * redeclared -- see UsageSettings above for the identical precedent. */
export type ArchiveTranscriptTurn = JsonlDisplayTurn

/** Main -> renderer response for archiveReadSession. A discriminated result (rather than throwing over
 * IPC) so a read failure -- transcript deleted/moved outside the app, containment-check rejection, etc.
 * -- is a typed, user-visible outcome instead of an opaque rejected promise (silent failure prohibited).
 *
 * `truncated`/`omittedCount` (M5 FIX, deferred item 2): archived transcripts can grow to many thousands
 * of turns in real use; `turns` is capped main-side (main/archive/archiveReader.ts's MAX_DISPLAY_TURNS,
 * oldest turns dropped first) to avoid handing the renderer an unbounded array. `truncated` is explicit
 * rather than left for the renderer to infer from array length, and `omittedCount` says exactly how many
 * older turns were dropped, so the viewer can say so instead of silently showing a partial transcript. */
export type ArchiveReadSessionResult =
  | { ok: true; turns: ArchiveTranscriptTurn[]; truncated: boolean; omittedCount: number }
  | { ok: false; reason: string }

// ---- M6: archive output-destination mirroring (spec §4.4.1, §5 archive_mirror table, ADR-0008) ----

/** Renderer -> main: set (or, with `root: null`, clear) the archive-output mirror destination.
 * `null` only ever clears app_settings.archive_output_root -- it never deletes anything already mirrored
 * (D-4/D-6: mirror data is append-only and outlives the setting that produced it). */
export interface SetArchiveOutputRootRequest {
  root: string | null
}

/** Discriminated result (not a thrown error) so an invalid/unwritable destination is a typed, renderer-
 * displayable outcome (D-5: "silent failure 禁止") -- covers both the pure self-mirror-containment check
 * (shared/mirrorPlan.ts's validateMirrorRoot) and the effectful write-probe (fsSink.ts's probeWritable). */
export type SetArchiveOutputRootResult = { ok: true } | { ok: false; reason: string }

/** Per-session mirror sync state (spec §5 archive_mirror.state). Mirrors the spool (source of truth) into
 * the configured output root; this column, and the whole archive_mirror table, is a *recoverable derived*
 * view of that progress, never the record of truth itself (D-6). */
export type MirrorState = 'pending' | 'synced' | 'error'

export interface MirrorStatusEntry {
  sessionId: string
  state: MirrorState
  lastError: string | null
  updatedAt: number
}

/** Main -> renderer (poll response + push on `archiveMirrorStatusUpdated`): the full current mirror
 * picture for the *currently configured* output root. `outputRoot: null` means mirroring is off
 * (`entries` is then always `[]` -- nothing is tracked while unconfigured, spec §4.4.1). */
export interface MirrorStatusSummary {
  outputRoot: string | null
  entries: MirrorStatusEntry[]
}

/** Pushed main -> renderer while an explicit backfill (spec §4.4.1 "自動実行しない") is running, and once
 * more with `done: true` at the end -- so the settings UI can show progress and a definite completion/
 * failure outcome rather than leaving the user guessing (D-5 silent-failure prohibition extends to this
 * long-running operation too). */
export interface BackfillProgressEvent {
  totalSessions: number
  processedSessions: number
  failedSessions: number
  done: boolean
}

// ---- M9: purpose-completion evaluation (spec §2/§4.6 deferred "事後分析", ADR-0010, §5 evaluations
// table). No standalone "create evaluation" IPC entrypoint exists here either (same design as purposes'
// paneLaunchStart) -- an evaluation row only ever comes into existence via completePurpose's fire-and-
// forget trigger (D-1) or the explicit evaluationRerun below; the renderer only ever reads. ----

export interface SetEvaluationEnabledRequest {
  enabled: boolean
}

export interface SetEvaluationModelRequest {
  model: string
}

/** Same discriminated-result shape as SetArchiveOutputRootResult (ADR-0008 D-5 precedent): a probe
 * failure is a typed, renderer-displayable outcome, never a thrown error (silent failure prohibited). */
export type SetEvaluationOutputRootRequest = { root: string | null }
export type SetEvaluationOutputRootResult = { ok: true } | { ok: false; reason: string }

export type EvaluationStatus = 'pending' | 'ok' | 'error' | 'skipped'

/** `null` = not applicable (evaluation not yet 'ok', or no output root configured at the time it became
 * 'ok'); 'written'/'error' only ever apply once the evaluation itself is 'ok' (D-5: a report-write
 * failure never flips the evaluation's own `status` to 'error'). */
export type EvaluationReportState = 'written' | 'error' | null

/** DTO pushed/returned for a single evaluation row (spec §5 `evaluations` table, main/db/evaluationRepo.ts).
 * Score fields are `null` while `status` is 'pending'/'skipped'/'error' (D-3: DB stores the raw,
 * requirement-literal polarity -- stress/commCost are "higher is worse"; the renderer's radar chart is
 * solely responsible for the "larger area = better" 100-x display transform, spec §4/D-3). */
export interface EvaluationSummary {
  id: string
  purposeId: string
  createdAt: number
  model: string | null
  status: EvaluationStatus
  smoothness: number | null
  stress: number | null
  commCost: number | null
  summary: string | null
  suggestions: EvaluationSuggestion[]
  inputStats: EvaluationInputStats | null
  lastError: string | null
  reportState: EvaluationReportState
}

export interface EvaluationGetForPurposeRequest {
  purposeId: string
}

/** R-7: re-run always creates a brand-new `evaluations` row (append-only) rather than editing the
 * existing one -- fire-and-forget, same as the original completePurpose-triggered run (D-1/D-4). */
export interface EvaluationRerunRequest {
  purposeId: string
}
