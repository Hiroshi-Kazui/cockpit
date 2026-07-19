// Composes the M5 read-only past-session browsing feature (spec §4.4): SQLite list/search
// (main/db/sessionRepo.ts) + safe archived-transcript reading (main/archive/archiveReader.ts). This is
// the only place the two are wired together, so main/ipc/handlers.ts stays a thin validation/dispatch
// layer (consistent with how every other IPC domain in this app is wired: handlers.ts calls straight into
// a narrow port, all business logic lives one layer down). Exposed as a small port interface
// (`ArchiveBrowserPort`) rather than the concrete class below so ipc/handlers.test.ts can inject a fake,
// the same dependency-inversion pattern ports.ts already establishes for SessionStore/PurposeStore.
//
// `createArchiveBrowser` below takes its two dependencies (session lookup, transcript read) as narrow
// injected functions -- not a raw `Database`/`archiveRoot` pair -- specifically so its not-found/null-
// jsonlPath/read-error branching is unit-testable with plain fakes (better-sqlite3 cannot load under
// plain Node/vitest here, same constraint sessionRepo.ts's header comment documents). The real
// `createSqliteArchiveBrowser` adapter at the bottom just wires the actual SQLite/filesystem functions in.
//
// M5 FIX (deferred item 3b): the DB->renderer row->DTO mapping (`toArchiveSessionListItem` below) lives
// here rather than in sessionRepo.ts, so sessionRepo.ts stays a neutral row source (`SessionListRow`, no
// `PaneIndex`/renderer-DTO knowledge) and this composition layer -- which already owns the
// `ArchiveSessionListItem`-shaped IPC contract for `listSessions` -- owns the one place that produces it.
import type { Database } from 'better-sqlite3'
import type {
  ArchiveListSessionsRequest,
  ArchiveReadSessionResult,
  ArchiveSessionListItem
} from '../../shared/ipc'
import { toPaneIndex } from '../../shared/ipc'
import { getSession, listSessions, type SessionListRow } from '../db/sessionRepo'
import {
  ArchiveTranscriptReadError,
  readArchivedTranscript,
  type ReadArchivedTranscriptResult
} from './archiveReader'

export interface ArchiveBrowserPort {
  listSessions(query: ArchiveListSessionsRequest): ArchiveSessionListItem[]
  readSession(sessionId: string): Promise<ArchiveReadSessionResult>
}

/** M5 FIX (deferred item 3c): replaces the previous `string | null | undefined` three-value contract
 * (undefined = session id unknown, null = known session with no archived transcript yet, string = the
 * path) with a discriminated union -- the old shape made "unknown session" and "no transcript yet"
 * indistinguishable from a type checker's point of view (both are falsy-ish, easy to conflate at a call
 * site), whereas `found: false` vs `found: true; jsonlPath: string | null` makes the two cases
 * structurally distinct and exhaustively checkable. */
export type SessionJsonlLookup = { found: false } | { found: true; jsonlPath: string | null }

export interface ArchiveBrowserDeps {
  /** Neutral DB rows (no renderer-DTO/PaneIndex narrowing) -- see this file's header comment. */
  listSessions: (query: ArchiveListSessionsRequest) => SessionListRow[]
  /** Looks up just enough of a session row to locate its archived transcript. */
  getSessionJsonlPath: (sessionId: string) => SessionJsonlLookup
  /** Reads+parses an already-contained-and-verified transcript path; must throw
   * ArchiveTranscriptReadError (never a raw error) on failure -- see archiveReader.ts. */
  readTranscript: (jsonlPath: string) => Promise<ReadArchivedTranscriptResult>
}

/** DB row -> renderer DTO. `toPaneIndex` throws only on a genuinely corrupt/out-of-range DB value (see
 * shared/ipc.ts's doc comment); every row in normal operation was already written with a validated pane. */
function toArchiveSessionListItem(row: SessionListRow): ArchiveSessionListItem {
  return { ...row, pane: toPaneIndex(row.pane) }
}

/** Pure(ish) composition -- see file header for why this takes narrow function deps instead of a raw
 * `Database`/`archiveRoot` pair. */
export function createArchiveBrowser(deps: ArchiveBrowserDeps): ArchiveBrowserPort {
  return {
    listSessions: (query) => deps.listSessions(query).map(toArchiveSessionListItem),
    readSession: async (sessionId): Promise<ArchiveReadSessionResult> => {
      const lookup = deps.getSessionJsonlPath(sessionId)
      if (!lookup.found) {
        return { ok: false, reason: `セッションが見つかりません: ${sessionId}` }
      }
      if (lookup.jsonlPath === null) {
        // A session row can exist with jsonlPath still null only in a defensive edge case -- in practice
        // createSession always sets jsonlPath in the same call that creates the row (see
        // sessionCoordinator.ts's linkSession), so this is not an observed real path, but is reported as
        // a typed failure either way rather than crashing on a null path.
        return {
          ok: false,
          reason: `このセッションにはアーカイブされた記録がありません: ${sessionId}`
        }
      }
      try {
        const result = await deps.readTranscript(lookup.jsonlPath)
        return {
          ok: true,
          turns: result.turns,
          truncated: result.truncated,
          omittedCount: result.omittedCount
        }
      } catch (err) {
        const reason = err instanceof ArchiveTranscriptReadError ? err.message : String(err)
        return { ok: false, reason }
      }
    }
  }
}

/** Real adapter, backed by SQLite (session metadata) + the filesystem (archived transcript). */
export function createSqliteArchiveBrowser(db: Database, archiveRoot: string): ArchiveBrowserPort {
  return createArchiveBrowser({
    listSessions: (query) => listSessions(db, query),
    getSessionJsonlPath: (sessionId): SessionJsonlLookup => {
      const row = getSession(db, sessionId)
      return row ? { found: true, jsonlPath: row.jsonlPath } : { found: false }
    },
    readTranscript: (jsonlPath) => readArchivedTranscript(archiveRoot, jsonlPath)
  })
}
