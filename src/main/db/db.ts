// Owns the better-sqlite3 connection lifecycle (TD-6). Schema DDL lives in ./schema.ts, kept free of
// any Electron import so it can be exercised in unit tests without the Electron runtime.
import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { migrate } from './schema'

let dbInstance: Database.Database | null = null

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance
  const dir = app.getPath('userData')
  fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, 'cockpit.db')
  const database = new Database(dbPath)
  database.pragma('journal_mode = WAL')
  migrate(database)
  dbInstance = database
  return database
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}
