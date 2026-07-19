// Narrow persistence/side-effect interfaces that sessionCoordinator depends on (dependency inversion).
// This keeps the session-linking/closing logic (TD-2, TD-3) unit-testable against in-memory fakes
// without needing a real SQLite engine or the Electron runtime -- both of which are unavailable under
// plain Node/vitest here (better-sqlite3's native binary is rebuilt for Electron's ABI, see
// main/db/sessionRepo.ts's `createSqliteSessionStore` for the real adapter used in production).
import type { PaneIndex, PurposeSummary, SessionOrigin } from '../../shared/ipc'
import type { JsonlUsage } from '../../shared/jsonl'

export interface SessionRow {
  id: string
  pane: number
  purposeId: string | null
  origin: SessionOrigin
  purpose: string | null
  title: string | null
  cwd: string | null
  startedAt: number
  endedAt: number | null
  jsonlPath: string | null
  model: string | null
  tokensIn: number
  tokensOut: number
  tokensCacheRead: number
  tokensCacheWrite: number
}

export interface CreateSessionParams {
  id: string
  pane: PaneIndex
  purposeId: string | null
  origin: SessionOrigin
  purpose: string | null
  title: string | null
  cwd: string | null
  startedAt: number
  jsonlPath: string
  model: string | null
}

export interface SessionStore {
  createSession(params: CreateSessionParams): void
  /** TD-2: known session_id resurfacing (/resume) reopens the existing row (ended_at = NULL).
   * `originOverride` (M4, TD-7) additionally sets `origin` when a restart-launch's `--continue`
   * happens to resurface a session_id that already has a (closed) row from a prior pty lifecycle --
   * see sessionCoordinator.ts's linkSession for why this can't always be a brand-new row (session_id
   * is the primary key, spec §5). Omitted/undefined leaves the row's existing origin untouched
   * (ordinary same-lifecycle /resume, TD-2's original behavior). */
  reopenSession(id: string, originOverride?: SessionOrigin): void
  closeSession(id: string, endedAt: number): void
  updateModelIfNull(id: string, model: string): void
  addTokens(id: string, usage: JsonlUsage): void
  getSession(id: string): SessionRow | null
  getAllOpenSessions(): SessionRow[]
}

export interface PurposeStore {
  getActivePurposeForPane(pane: PaneIndex): PurposeSummary | null
}

/** The subset of SessionArchiver's API sessionCoordinator needs -- satisfied structurally by the real
 * class in main/archive/archiver.ts, and by a spy/fake in tests. */
export interface ArchiverPort {
  attach(sessionId: string, transcriptPath: string, archiveDir: string): string
  detach(sessionId: string): void
}
