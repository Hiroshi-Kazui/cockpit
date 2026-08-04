// CRUD for the `evaluations` table (spec §5, ADR-0010). The only module allowed to touch this table
// directly -- evaluationCoordinator.ts (main/evaluation/) decides *when* to call these, this module only
// persists. Append-only by construction (R-6): there is no delete function and no function that rewrites
// an already-finalized row's scores -- `finalizeEvaluationOk`/`finalizeEvaluationError` are guarded by
// `WHERE status = 'pending'`, so a row can only ever transition pending -> {ok, error} exactly once; a
// re-run (R-7) always inserts a brand-new row instead. `setEvaluationReportState` is the one other
// allowed UPDATE (report write-through outcome, independent of the evaluation's own score/status).
import crypto from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type {
  EvaluationHistoryEntry,
  EvaluationInputStats,
  EvaluationReportState,
  EvaluationStatus,
  EvaluationSuggestion,
  EvaluationSummary
} from '../../shared/ipc'

interface RawEvaluationRow {
  id: string
  purpose_id: string
  created_at: number
  model: string | null
  status: string
  smoothness: number | null
  stress: number | null
  comm_cost: number | null
  summary: string | null
  suggestions_json: string | null
  input_stats_json: string | null
  last_error: string | null
  report_state: string | null
}

function isEvaluationStatus(value: string): value is EvaluationStatus {
  return value === 'pending' || value === 'ok' || value === 'error' || value === 'skipped'
}

function isReportState(value: string | null): value is EvaluationReportState {
  return value === null || value === 'written' || value === 'error'
}

/** Tolerant JSON parse (spec §7/CLAUDE.md "パーサは寛容"): a hand-edited or somehow-corrupted JSON
 * column must never crash the read path -- it degrades to the safe empty/null default instead. */
function parseSuggestionsJson(raw: string | null): EvaluationSuggestion[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is EvaluationSuggestion =>
        typeof item === 'object' &&
        item !== null &&
        (item as Record<string, unknown>)['category'] !== undefined &&
        typeof (item as Record<string, unknown>)['text'] === 'string'
    )
  } catch {
    return []
  }
}

function parseInputStatsJson(raw: string | null): EvaluationInputStats | null {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as EvaluationInputStats
  } catch {
    return null
  }
}

function toSummary(row: RawEvaluationRow): EvaluationSummary {
  return {
    id: row.id,
    purposeId: row.purpose_id,
    createdAt: row.created_at,
    model: row.model,
    status: isEvaluationStatus(row.status) ? row.status : 'error',
    smoothness: row.smoothness,
    stress: row.stress,
    commCost: row.comm_cost,
    summary: row.summary,
    suggestions: parseSuggestionsJson(row.suggestions_json),
    inputStats: parseInputStatsJson(row.input_stats_json),
    lastError: row.last_error,
    reportState: isReportState(row.report_state) ? row.report_state : null
  }
}

export interface InsertPendingEvaluationParams {
  purposeId: string
  createdAt: number
  model: string | null
  inputStats: EvaluationInputStats
}

/** Inserts a new 'pending' row and immediately returns its summary so the caller (evaluationCoordinator)
 * can push it to the renderer right away (R-2 "評価進行中はその旨が表示され...UIが無言のまま待たせない"),
 * before the (possibly slow) headless LLM call has even started. */
export function insertPendingEvaluation(
  db: Database,
  params: InsertPendingEvaluationParams
): EvaluationSummary {
  const id = crypto.randomUUID()
  db.prepare(
    `INSERT INTO evaluations
       (id, purpose_id, created_at, model, status, smoothness, stress, comm_cost, summary,
        suggestions_json, input_stats_json, last_error, report_state)
     VALUES
       (@id, @purposeId, @createdAt, @model, 'pending', NULL, NULL, NULL, NULL,
        NULL, @inputStatsJson, NULL, NULL)`
  ).run({
    id,
    purposeId: params.purposeId,
    createdAt: params.createdAt,
    model: params.model,
    inputStatsJson: JSON.stringify(params.inputStats)
  })
  return toSummary(getRawById(db, id)!)
}

export interface InsertSkippedEvaluationParams {
  purposeId: string
  createdAt: number
  model: string | null
  inputStats: EvaluationInputStats
}

/** D-8 "実質空の入力は LLM を呼ばず skipped で確定する": inserted directly in its terminal 'skipped'
 * state -- there is nothing to transition out of pending for (no LLM call was ever made). */
export function insertSkippedEvaluation(
  db: Database,
  params: InsertSkippedEvaluationParams
): EvaluationSummary {
  const id = crypto.randomUUID()
  db.prepare(
    `INSERT INTO evaluations
       (id, purpose_id, created_at, model, status, smoothness, stress, comm_cost, summary,
        suggestions_json, input_stats_json, last_error, report_state)
     VALUES
       (@id, @purposeId, @createdAt, @model, 'skipped', NULL, NULL, NULL, NULL,
        NULL, @inputStatsJson, NULL, NULL)`
  ).run({
    id,
    purposeId: params.purposeId,
    createdAt: params.createdAt,
    model: params.model,
    inputStatsJson: JSON.stringify(params.inputStats)
  })
  return toSummary(getRawById(db, id)!)
}

export interface FinalizeEvaluationOkParams {
  smoothness: number
  stress: number
  commCost: number
  summary: string
  suggestions: EvaluationSuggestion[]
}

/** The one-time pending -> 'ok' transition (R-6/R-7). `WHERE status = 'pending'` makes this a no-op
 * (zero rows affected) if the row is somehow already finalized -- defense-in-depth against a caller bug
 * ever attempting a second write to an already-terminal row. Returns null if the row does not exist or
 * was not in 'pending' state (nothing was changed). */
export function finalizeEvaluationOk(
  db: Database,
  id: string,
  params: FinalizeEvaluationOkParams
): EvaluationSummary | null {
  const result = db
    .prepare(
      `UPDATE evaluations
       SET status = 'ok', smoothness = @smoothness, stress = @stress, comm_cost = @commCost,
           summary = @summary, suggestions_json = @suggestionsJson
       WHERE id = @id AND status = 'pending'`
    )
    .run({
      id,
      smoothness: params.smoothness,
      stress: params.stress,
      commCost: params.commCost,
      summary: params.summary,
      suggestionsJson: JSON.stringify(params.suggestions)
    })
  if (result.changes === 0) return null
  return toSummary(getRawById(db, id)!)
}

/** The one-time pending -> 'error' transition (R-7: claude 解決不能・タイムアウト・JSON 復元不能等). Same
 * `WHERE status = 'pending'` guard as finalizeEvaluationOk. */
export function finalizeEvaluationError(
  db: Database,
  id: string,
  lastError: string
): EvaluationSummary | null {
  const result = db
    .prepare(
      `UPDATE evaluations SET status = 'error', last_error = @lastError
       WHERE id = @id AND status = 'pending'`
    )
    .run({ id, lastError })
  if (result.changes === 0) return null
  return toSummary(getRawById(db, id)!)
}

/** D-5: the one field allowed to change independently of the pending->terminal transition above -- a
 * report write-through outcome recorded after the evaluation itself is already 'ok'. Never fails the
 * evaluation itself (R-5 "レポート書き出し失敗は評価自体を error にせず"). */
export function setEvaluationReportState(
  db: Database,
  id: string,
  state: EvaluationReportState
): EvaluationSummary | null {
  db.prepare(`UPDATE evaluations SET report_state = ? WHERE id = ?`).run(state, id)
  const row = getRawById(db, id)
  return row ? toSummary(row) : null
}

function getRawById(db: Database, id: string): RawEvaluationRow | null {
  const row = db.prepare('SELECT * FROM evaluations WHERE id = ?').get(id) as
    RawEvaluationRow | undefined
  return row ?? null
}

export function getEvaluationById(db: Database, id: string): EvaluationSummary | null {
  const row = getRawById(db, id)
  return row ? toSummary(row) : null
}

/** The purpose's current evaluation (R-7 "目的ごとの現行評価は「最新の行」で決まる"). */
export function getLatestEvaluationForPurpose(
  db: Database,
  purposeId: string
): EvaluationSummary | null {
  const row = db
    .prepare(
      `SELECT * FROM evaluations WHERE purpose_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(purposeId) as RawEvaluationRow | undefined
  return row ? toSummary(row) : null
}

interface RawHistoryRow {
  id: string
  purpose_id: string
  created_at: number
  status: string
  smoothness: number | null
  stress: number | null
  comm_cost: number | null
}

/** Every evaluation row (every status, every purpose), for the R-4 dashboard's weekly/monthly/overall
 * aggregation (shared/evaluationAggregate.ts's pure bucketing functions do the status/null filtering --
 * this just hands back the raw history, unfiltered, so that filtering logic lives in exactly one place). */
export function listAllEvaluationHistory(db: Database): EvaluationHistoryEntry[] {
  const rows = db
    .prepare(
      `SELECT id, purpose_id, created_at, status, smoothness, stress, comm_cost
       FROM evaluations ORDER BY created_at ASC`
    )
    .all() as RawHistoryRow[]
  return rows.map((row) => ({
    id: row.id,
    purposeId: row.purpose_id,
    createdAt: row.created_at,
    status: isEvaluationStatus(row.status) ? row.status : 'error',
    smoothness: row.smoothness,
    stress: row.stress,
    commCost: row.comm_cost
  }))
}
