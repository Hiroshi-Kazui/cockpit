// Unit tests for the ADR-0009 idempotent archive_mirror migration (M6 single-column session_id PK ->
// M7 composite (session_id, dest_root) PK). Real better-sqlite3 cannot load under plain Node/vitest here
// (its native binary is rebuilt for Electron's ABI -- see sessionRepo.test.ts's header comment for the
// same constraint verified empirically), so schema.ts's actual migrate() DDL/DML text is exercised here
// against a minimal, purpose-built in-memory fake `Database` (FakeDatabase below) rather than the real
// engine. This is deliberately NOT a general SQL reimplementation -- it only interprets the handful of
// statement shapes migrate() actually emits (CREATE TABLE [IF NOT EXISTS], CREATE INDEX IF NOT EXISTS,
// INSERT ... SELECT, DROP TABLE, ALTER TABLE ... RENAME TO, PRAGMA table_info) -- but it runs the *real*
// migrate() function's own SQL text, so a change to that text is exercised by these tests, not by a
// hand-simplified stand-in.
import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { migrate, needsArchiveMirrorMigration } from './schema'

interface FakeColumn {
  name: string
  pk: number
}
interface FakeTable {
  columns: FakeColumn[]
  rows: Array<Record<string, unknown>>
}

class FakeDatabase {
  tables = new Map<string, FakeTable>()

  exec(sql: string): void {
    for (const statement of splitStatements(stripComments(sql))) {
      this.execOne(statement)
    }
  }

  prepare(sql: string): { all: () => unknown[] } {
    const pragmaMatch = /^PRAGMA table_info\((\w+)\)$/i.exec(sql.trim())
    if (pragmaMatch) {
      const table = this.tables.get(pragmaMatch[1])
      return { all: () => (table ? table.columns.map((c) => ({ name: c.name, pk: c.pk })) : []) }
    }
    throw new Error(`FakeDatabase.prepare: unsupported statement: ${sql}`)
  }

  /** FIX (blocking, code review): schema.ts's migrateArchiveMirrorToCompositeKey now wraps its DDL/DML in
   * `database.transaction(...)`. This fake does not attempt to simulate real atomicity/rollback (that would
   * require reimplementing SQLite's MVCC, well beyond this fake's deliberately narrow scope) -- it just runs
   * `fn` directly, same as calling it standalone. What these tests actually pin down is the *observable*
   * blocking-issue invariant: re-running migrate() after a crash left `archive_mirror__m7_migrating` behind
   * must not throw (see the regression test below), which does not depend on this fake's transaction
   * semantics being real. */
  transaction<F extends () => void>(fn: F): () => void {
    return () => fn()
  }

  private execOne(statement: string): void {
    const s = statement.trim()
    if (s.length === 0) return
    let m: RegExpMatchArray | null

    m = /^CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*)\)$/i.exec(s)
    if (m) {
      if (!this.tables.has(m[1])) this.tables.set(m[1], { columns: parseColumns(m[2]), rows: [] })
      return
    }
    m = /^CREATE TABLE (\w+)\s*\(([\s\S]*)\)$/i.exec(s)
    if (m) {
      // Mirrors real SQLite: CREATE TABLE without IF NOT EXISTS throws ("table already exists") if the
      // table is already there -- this is exactly what the blocking-issue regression test below depends on
      // to demonstrate the *old* (pre-fix) CREATE-without-DROP-IF-EXISTS sequence would have failed.
      if (this.tables.has(m[1])) {
        throw new Error(`FakeDatabase: table "${m[1]}" already exists`)
      }
      this.tables.set(m[1], { columns: parseColumns(m[2]), rows: [] })
      return
    }
    if (/^CREATE INDEX IF NOT EXISTS \w+ ON \w+\([\s\S]*\)$/i.test(s)) return

    m = /^INSERT INTO (\w+)\s*\(([\s\S]*?)\)\s*SELECT ([\s\S]*?) FROM (\w+)$/i.exec(s)
    if (m) {
      const [, destName, destColsRaw, srcColsRaw, srcName] = m
      const destCols = destColsRaw.split(',').map((c) => c.trim())
      const srcCols = srcColsRaw.split(',').map((c) => c.trim())
      const dest = this.tables.get(destName)
      const src = this.tables.get(srcName)
      if (!dest || !src) throw new Error(`unknown table in INSERT SELECT: ${s}`)
      for (const row of src.rows) {
        const newRow: Record<string, unknown> = {}
        destCols.forEach((destCol, i) => {
          newRow[destCol] = row[srcCols[i]]
        })
        dest.rows.push(newRow)
      }
      return
    }

    // "IF EXISTS" is optional -- DROP TABLE IF EXISTS is a safe no-op on a Map whether or not the key is
    // present, matching real SQLite's IF-EXISTS semantics exactly (unlike a plain DROP TABLE of a table
    // that doesn't exist, which real SQLite -- and this fake, deliberately not modeled since migrate() never
    // does it -- would error on).
    m = /^DROP TABLE(?: IF EXISTS)? (\w+)$/i.exec(s)
    if (m) {
      this.tables.delete(m[1])
      return
    }

    m = /^ALTER TABLE (\w+) RENAME TO (\w+)$/i.exec(s)
    if (m) {
      const table = this.tables.get(m[1])
      if (!table) throw new Error(`unknown table in ALTER TABLE RENAME: ${s}`)
      this.tables.delete(m[1])
      this.tables.set(m[2], table)
      return
    }

    throw new Error(`FakeDatabase.exec: unsupported statement: ${s}`)
  }
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of body) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim().length > 0) parts.push(current)
  return parts
}

function parseColumns(body: string): FakeColumn[] {
  const parts = splitTopLevel(body)
  const columns: FakeColumn[] = []
  let compositePk: string[] | null = null
  for (const part of parts) {
    const trimmed = part.trim()
    const pkListMatch = /^PRIMARY KEY\s*\(([\s\S]*)\)$/i.exec(trimmed)
    if (pkListMatch) {
      compositePk = pkListMatch[1].split(',').map((c) => c.trim())
      continue
    }
    const nameMatch = /^(\w+)\s+/.exec(trimmed)
    if (!nameMatch) continue
    const name = nameMatch[1]
    const isInlinePk = /PRIMARY KEY/i.test(trimmed)
    columns.push({ name, pk: isInlinePk ? 1 : 0 })
  }
  if (compositePk) {
    for (const col of columns) {
      const idx = compositePk.indexOf(col.name)
      if (idx >= 0) col.pk = idx + 1
    }
  }
  return columns
}

function asDb(fake: FakeDatabase): Database {
  return fake as unknown as Database
}

const M6_SHAPE_DDL = `CREATE TABLE archive_mirror (
  session_id TEXT PRIMARY KEY,
  dest_root TEXT NOT NULL,
  synced_bytes INTEGER NOT NULL DEFAULT 0,
  meta_synced INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  updated_at INTEGER NOT NULL
)`

describe('needsArchiveMirrorMigration (pure, ADR-0009)', () => {
  it('is false when the table does not exist yet (fresh install)', () => {
    expect(needsArchiveMirrorMigration([])).toBe(false)
  })

  it('is true for the M6 single-column session_id primary key shape', () => {
    expect(
      needsArchiveMirrorMigration([
        { name: 'session_id', pk: 1 },
        { name: 'dest_root', pk: 0 },
        { name: 'synced_bytes', pk: 0 }
      ])
    ).toBe(true)
  })

  it('is false once already migrated to the (session_id, dest_root) composite key', () => {
    expect(
      needsArchiveMirrorMigration([
        { name: 'session_id', pk: 1 },
        { name: 'dest_root', pk: 2 },
        { name: 'synced_bytes', pk: 0 }
      ])
    ).toBe(false)
  })
})

describe('migrate() -- ADR-0009 archive_mirror composite-key migration', () => {
  it('migrates an M6-shape table with existing rows to the composite key, losslessly', () => {
    const db = new FakeDatabase()
    db.exec(M6_SHAPE_DDL)
    db.tables.get('archive_mirror')!.rows.push(
      {
        session_id: 'sess-1',
        dest_root: 'D:\\A',
        synced_bytes: 42,
        meta_synced: 1,
        state: 'synced',
        last_error: null,
        updated_at: 111
      },
      {
        session_id: 'sess-2',
        dest_root: 'D:\\B',
        synced_bytes: 7,
        meta_synced: 0,
        state: 'error',
        last_error: 'boom',
        updated_at: 222
      }
    )

    migrate(asDb(db))

    const table = db.tables.get('archive_mirror')!
    expect(
      table.columns
        .filter((c) => c.pk > 0)
        .map((c) => c.name)
        .sort()
    ).toEqual(['dest_root', 'session_id'])
    expect(table.rows).toEqual([
      {
        session_id: 'sess-1',
        dest_root: 'D:\\A',
        synced_bytes: 42,
        meta_synced: 1,
        state: 'synced',
        last_error: null,
        updated_at: 111
      },
      {
        session_id: 'sess-2',
        dest_root: 'D:\\B',
        synced_bytes: 7,
        meta_synced: 0,
        state: 'error',
        last_error: 'boom',
        updated_at: 222
      }
    ])
  })

  it('is idempotent -- running migrate() again on an already-migrated table changes nothing', () => {
    const db = new FakeDatabase()
    db.exec(M6_SHAPE_DDL)
    db.tables.get('archive_mirror')!.rows.push({
      session_id: 'sess-1',
      dest_root: 'D:\\A',
      synced_bytes: 42,
      meta_synced: 1,
      state: 'synced',
      last_error: null,
      updated_at: 111
    })

    migrate(asDb(db))
    migrate(asDb(db)) // second run: must be a no-op, not a duplicate/drop of already-migrated rows

    const table = db.tables.get('archive_mirror')!
    expect(table.rows).toHaveLength(1)
    expect(table.rows[0]).toEqual({
      session_id: 'sess-1',
      dest_root: 'D:\\A',
      synced_bytes: 42,
      meta_synced: 1,
      state: 'synced',
      last_error: null,
      updated_at: 111
    })
  })

  // Blocking-issue regression test: a crash between CREATE TABLE archive_mirror__m7_migrating and DROP
  // TABLE archive_mirror on some prior startup attempt would (without this fix) leave the scratch table
  // behind while the old-shape archive_mirror table -- still the source of truth at that point -- survives
  // untouched. The *next* startup's migrate() call must still succeed (not throw "table already exists" out
  // of CREATE TABLE archive_mirror__m7_migrating, which would otherwise permanently fail every subsequent
  // app launch) and must still produce a correct, lossless migration from the surviving old-shape data.
  it('does not throw and completes the migration when a leftover intermediate table survives from a prior interrupted attempt', () => {
    const db = new FakeDatabase()
    db.exec(M6_SHAPE_DDL)
    db.tables.get('archive_mirror')!.rows.push({
      session_id: 'sess-1',
      dest_root: 'D:\\A',
      synced_bytes: 42,
      meta_synced: 1,
      state: 'synced',
      last_error: null,
      updated_at: 111
    })
    // Simulates the scratch table surviving a crash on a previous startup attempt (CREATE succeeded, DROP
    // never ran). Deliberately left empty/stale here -- migrateArchiveMirrorToCompositeKey's own
    // DROP TABLE IF EXISTS discards it unconditionally before rebuilding from the still-intact old-shape
    // archive_mirror table above, so its prior contents are irrelevant to the correct outcome.
    db.exec(`CREATE TABLE archive_mirror__m7_migrating (
      session_id TEXT NOT NULL,
      dest_root TEXT NOT NULL,
      synced_bytes INTEGER NOT NULL DEFAULT 0,
      meta_synced INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, dest_root)
    )`)

    expect(() => migrate(asDb(db))).not.toThrow()

    const table = db.tables.get('archive_mirror')!
    expect(
      table.columns
        .filter((c) => c.pk > 0)
        .map((c) => c.name)
        .sort()
    ).toEqual(['dest_root', 'session_id'])
    expect(table.rows).toEqual([
      {
        session_id: 'sess-1',
        dest_root: 'D:\\A',
        synced_bytes: 42,
        meta_synced: 1,
        state: 'synced',
        last_error: null,
        updated_at: 111
      }
    ])
    // The scratch table itself must not linger after a successful migration.
    expect(db.tables.has('archive_mirror__m7_migrating')).toBe(false)
  })

  it('creates the composite-key table fresh when archive_mirror does not exist yet (new install)', () => {
    const db = new FakeDatabase()

    migrate(asDb(db))

    const table = db.tables.get('archive_mirror')!
    expect(table).toBeDefined()
    expect(
      table.columns
        .filter((c) => c.pk > 0)
        .map((c) => c.name)
        .sort()
    ).toEqual(['dest_root', 'session_id'])
    expect(table.rows).toEqual([])
  })

  it('also creates every other table (sessions, purposes, pane_settings, app_settings) unaffected by the migration', () => {
    const db = new FakeDatabase()

    migrate(asDb(db))

    expect(db.tables.has('pane_settings')).toBe(true)
    expect(db.tables.has('app_settings')).toBe(true)
    expect(db.tables.has('purposes')).toBe(true)
    expect(db.tables.has('sessions')).toBe(true)
  })
})

// M9 (spec §5 evaluations table, ADR-0010): the migration is a plain `CREATE TABLE IF NOT EXISTS`, so it
// needs no special migration logic of its own -- but AC "マイグレーションは既存DBに対して無損失・
// idempotent" still applies and is pinned here the same way as the archive_mirror migration above.
describe('migrate() -- M9 evaluations table', () => {
  it('creates the evaluations table with every documented column', () => {
    const db = new FakeDatabase()

    migrate(asDb(db))

    const table = db.tables.get('evaluations')
    expect(table).toBeDefined()
    const columnNames = table!.columns.map((c) => c.name).sort()
    expect(columnNames).toEqual(
      [
        'id',
        'purpose_id',
        'created_at',
        'model',
        'status',
        'smoothness',
        'stress',
        'comm_cost',
        'summary',
        'suggestions_json',
        'input_stats_json',
        'last_error',
        'report_state'
      ].sort()
    )
    expect(table!.columns.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['id'])
    expect(table!.rows).toEqual([])
  })

  it('is idempotent and lossless -- running migrate() again keeps existing rows untouched', () => {
    const db = new FakeDatabase()
    migrate(asDb(db))
    db.tables.get('evaluations')!.rows.push({
      id: 'eval-1',
      purpose_id: 'purpose-1',
      created_at: 111,
      model: 'haiku',
      status: 'ok',
      smoothness: 80,
      stress: 20,
      comm_cost: 10,
      summary: 'ok',
      suggestions_json: '[]',
      input_stats_json: '{}',
      last_error: null,
      report_state: null
    })

    expect(() => migrate(asDb(db))).not.toThrow()

    expect(db.tables.get('evaluations')!.rows).toHaveLength(1)
    expect(db.tables.get('evaluations')!.rows[0]).toMatchObject({ id: 'eval-1', status: 'ok' })
  })
})
