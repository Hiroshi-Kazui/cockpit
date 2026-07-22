// CRUD + lifecycle queries for the `sessions` table (spec §5). The only module allowed to write
// session rows directly against SQLite; sessionCoordinator (main/telemetry) decides *when* to call
// these via the SessionStore port, this module just persists. Also owns TD-3 crash recovery and (M5)
// the read-only list/search query backing the past-session browser (spec §4.4).
import type { Database } from 'better-sqlite3'
import fs from 'node:fs'
import type { ArchiveListSessionsRequest, SessionOrigin } from '../../shared/ipc'
import { buildContainsLikePattern } from '../../shared/sqlLike'
import type { CreateSessionParams, SessionRow, SessionStore } from '../telemetry/ports'

interface RawSessionRow {
  id: string
  pane: number
  purpose_id: string | null
  origin: string
  purpose: string | null
  title: string | null
  cwd: string | null
  started_at: number
  ended_at: number | null
  jsonl_path: string | null
  model: string | null
  tokens_in: number
  tokens_out: number
  tokens_cache_read: number
  tokens_cache_write: number
}

function isSessionOrigin(value: string): value is SessionOrigin {
  return value === 'dialog' || value === 'clear' || value === 'resume' || value === 'restart'
}

function toRow(raw: RawSessionRow): SessionRow {
  return {
    id: raw.id,
    pane: raw.pane,
    purposeId: raw.purpose_id,
    origin: isSessionOrigin(raw.origin) ? raw.origin : 'dialog',
    purpose: raw.purpose,
    title: raw.title,
    cwd: raw.cwd,
    startedAt: raw.started_at,
    endedAt: raw.ended_at,
    jsonlPath: raw.jsonl_path,
    model: raw.model,
    tokensIn: raw.tokens_in,
    tokensOut: raw.tokens_out,
    tokensCacheRead: raw.tokens_cache_read,
    tokensCacheWrite: raw.tokens_cache_write
  }
}

export function createSession(db: Database, params: CreateSessionParams): void {
  db.prepare(
    `INSERT INTO sessions
       (id, pane, purpose_id, origin, purpose, title, cwd, started_at, ended_at, jsonl_path, model,
        tokens_in, tokens_out, tokens_cache_read, tokens_cache_write)
     VALUES
       (@id, @pane, @purposeId, @origin, @purpose, @title, @cwd, @startedAt, NULL, @jsonlPath, @model,
        0, 0, 0, 0)`
  ).run(params)
}

export function reopenSession(db: Database, id: string, originOverride?: SessionOrigin): void {
  if (originOverride) {
    db.prepare(`UPDATE sessions SET ended_at = NULL, origin = ? WHERE id = ?`).run(
      originOverride,
      id
    )
  } else {
    db.prepare(`UPDATE sessions SET ended_at = NULL WHERE id = ?`).run(id)
  }
}

export function closeSession(db: Database, id: string, endedAt: number): void {
  db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(endedAt, id)
}

export function updateModelIfNull(db: Database, id: string, model: string): void {
  db.prepare(`UPDATE sessions SET model = ? WHERE id = ? AND model IS NULL`).run(model, id)
}

export function addTokens(
  db: Database,
  id: string,
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
  }
): void {
  db.prepare(
    `UPDATE sessions
     SET tokens_in = tokens_in + @in,
         tokens_out = tokens_out + @out,
         tokens_cache_read = tokens_cache_read + @cacheRead,
         tokens_cache_write = tokens_cache_write + @cacheWrite
     WHERE id = @id`
  ).run({
    id,
    in: usage.inputTokens,
    out: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheCreationTokens
  })
}

export function getSession(db: Database, id: string): SessionRow | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as RawSessionRow | undefined
  return row ? toRow(row) : null
}

/** M4 (spec §4.2/§4.4 "目的が空で開始した場合"): backfills `purpose`/`title` on every session row
 * already linked to a purpose once that purpose's text (and later, title) is decided from the session's
 * first non-command chat turn -- keeps archive metadata complete even for a session created (e.g. via
 * `/clear`, TD-2) before the decision landed, whose row still carries the stale empty copy made at link
 * time (main/telemetry/sessionCoordinator.ts's linkSession copies purpose.text/title verbatim at that
 * moment; it is never otherwise revisited). `WHERE purpose_id = ? AND (purpose = '' OR purpose IS NULL)`
 * (M4 FIX, minor #5): still idempotent/safe to call repeatedly, but scoped to only the pre-existing stale
 * rows this exists for -- any session linked *after* the purpose is decided already gets the correct
 * text at creation time (createSession above), so an unconditional update would otherwise perform a
 * pointless no-op write (same value back) on every already-correct row sharing the purpose_id too. */
export function backfillPurposeText(db: Database, purposeId: string, text: string): void {
  db.prepare(
    `UPDATE sessions SET purpose = ? WHERE purpose_id = ? AND (purpose = '' OR purpose IS NULL)`
  ).run(text, purposeId)
}

export function backfillPurposeTitle(db: Database, purposeId: string, title: string): void {
  db.prepare(
    `UPDATE sessions SET title = ? WHERE purpose_id = ? AND (title IS NULL OR title = '')`
  ).run(title, purposeId)
}

export function getAllOpenSessions(db: Database): SessionRow[] {
  const rows = db.prepare('SELECT * FROM sessions WHERE ended_at IS NULL').all() as RawSessionRow[]
  return rows.map(toRow)
}

/** M9 (ADR-0010 D-1): every session ever linked to a purpose (open or closed, any origin) -- the input
 * set for that purpose's completion evaluation. Ordered by started_at so evaluationCoordinator.ts reads
 * transcripts in chronological order (matters for D-8's deterministic "ユーザ発言を全量優先" ordering). */
export function listSessionsForPurpose(db: Database, purposeId: string): SessionRow[] {
  const rows = db
    .prepare('SELECT * FROM sessions WHERE purpose_id = ? ORDER BY started_at ASC')
    .all(purposeId) as RawSessionRow[]
  return rows.map(toRow)
}

interface RawSessionListRow {
  id: string
  pane: number
  purpose: string | null
  title: string | null
  cwd: string | null
  started_at: number
  ended_at: number | null
  model: string | null
  tokens_in: number
  tokens_out: number
  tokens_cache_read: number
  tokens_cache_write: number
}

const SESSION_LIST_COLUMNS = `
  id, pane, purpose, title, cwd, started_at, ended_at, model,
  tokens_in, tokens_out, tokens_cache_read, tokens_cache_write
`

/** M5 FIX (deferred item 3b): a neutral row shape -- camelCase, but deliberately *not* narrowed to the
 * renderer-facing `ArchiveSessionListItem` DTO (`pane` stays a plain `number`, matching the raw INTEGER
 * column, rather than `PaneIndex`). The row->DTO mapping (including the `PaneIndex` narrowing) lives in
 * the composition layer, main/archive/archiveBrowser.ts, not here -- this repo module only ever persists
 * and reads back what SQLite actually stores. */
export interface SessionListRow {
  id: string
  pane: number
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

function toListRow(row: RawSessionListRow): SessionListRow {
  return {
    id: row.id,
    pane: row.pane,
    purpose: row.purpose,
    title: row.title,
    cwd: row.cwd,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    model: row.model,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    tokensCacheRead: row.tokens_cache_read,
    tokensCacheWrite: row.tokens_cache_write
  }
}

const DEFAULT_LIST_LIMIT = 200
const MAX_LIST_LIMIT = 1000

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) return DEFAULT_LIST_LIMIT
  return Math.min(limit, MAX_LIST_LIMIT)
}

function resolveOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isInteger(offset) || offset < 0) return 0
  return offset
}

/** M5 (spec §4.4): list/search past sessions for the read-only browser, most-recently-started first.
 * `query.searchText` (already trimmed by the caller) is matched case-insensitively against
 * purpose/title/cwd via a parameter-bound LIKE pattern (shared/sqlLike.ts escapes %/_/\\ so a search
 * string containing them is matched literally, never as a wildcard) -- an empty string matches every
 * session (no WHERE clause at all, so it also can never accidentally exclude rows with a NULL
 * purpose/title/cwd via a LIKE-on-NULL false negative).
 *
 * NOTE on test coverage: like every other raw-SQL function in this file, this is exercised through the
 * `SessionStore`/`ArchiveBrowserPort`-shaped fakes in main/archive/archiveBrowser.test.ts rather than
 * directly -- better-sqlite3's native binary cannot load under plain Node/vitest here (see this file's
 * header comment and sessionRepo.test.ts). `LOWER(...)` case-folding is ASCII-only in SQLite without the
 * ICU extension (not loaded here); for CJK text (which has no case distinction anyway) this is a
 * non-issue, and for mixed-script text it still degrades gracefully to "ASCII casing is normalized,
 * non-ASCII matched byte-for-byte" rather than failing outright.
 */
export function listSessions(db: Database, query: ArchiveListSessionsRequest): SessionListRow[] {
  const searchText = query.searchText.trim()
  const limit = resolveLimit(query.limit)
  const offset = resolveOffset(query.offset)

  if (searchText.length === 0) {
    const rows = db
      .prepare(
        `SELECT ${SESSION_LIST_COLUMNS} FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as RawSessionListRow[]
    return rows.map(toListRow)
  }

  const pattern = buildContainsLikePattern(searchText)
  const rows = db
    .prepare(
      `SELECT ${SESSION_LIST_COLUMNS} FROM sessions
       WHERE LOWER(COALESCE(purpose, '')) LIKE LOWER(?) ESCAPE '\\'
          OR LOWER(COALESCE(title, '')) LIKE LOWER(?) ESCAPE '\\'
          OR LOWER(COALESCE(cwd, '')) LIKE LOWER(?) ESCAPE '\\'
       ORDER BY started_at DESC LIMIT ? OFFSET ?`
    )
    .all(pattern, pattern, pattern, limit, offset) as RawSessionListRow[]
  return rows.map(toListRow)
}

/** Adapts the raw SQLite functions above to the SessionStore port sessionCoordinator depends on
 * (dependency inversion; keeps sessionCoordinator testable without a real DB, see ports.ts). */
export function createSqliteSessionStore(db: Database): SessionStore {
  return {
    createSession: (params) => createSession(db, params),
    reopenSession: (id, originOverride) => reopenSession(db, id, originOverride),
    closeSession: (id, endedAt) => closeSession(db, id, endedAt),
    updateModelIfNull: (id, model) => updateModelIfNull(db, id, model),
    addTokens: (id, usage) => addTokens(db, id, usage),
    getSession: (id) => getSession(db, id),
    getAllOpenSessions: () => getAllOpenSessions(db)
  }
}

function statMtimeMsSafe(jsonlPath: string | null): number | null {
  if (!jsonlPath) return null
  try {
    return fs.statSync(jsonlPath).mtimeMs
  } catch {
    return null
  }
}

/** Pure: TD-3's "last observed activity time" rule applied to crash recovery. The archived transcript
 * copy's mtime stands in for "last JSONL append time" (statusLine receipt times are in-memory only and
 * are lost on a crash, so they cannot contribute here). Exported for unit testing. */
export function computeRepairEndedAt(startedAt: number, mtimeMs: number | null): number {
  if (mtimeMs !== null && mtimeMs >= startedAt) return Math.round(mtimeMs)
  return startedAt
}

/** TD-3 crash recovery (AC #11): close any `sessions` rows left open by a previous run that never got
 * a graceful shutdown (app crash / force-kill). Runs once at startup, before any new telemetry arrives. */
export function repairOpenSessions(db: Database): number {
  const rows = db
    .prepare('SELECT id, jsonl_path, started_at FROM sessions WHERE ended_at IS NULL')
    .all() as Array<{ id: string; jsonl_path: string | null; started_at: number }>
  for (const row of rows) {
    const endedAt = computeRepairEndedAt(row.started_at, statMtimeMsSafe(row.jsonl_path))
    closeSession(db, row.id, endedAt)
  }
  return rows.length
}
