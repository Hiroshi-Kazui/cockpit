// Watches a linked transcript JSONL file and mirrors newly-appended bytes into the app-managed archive
// (spec §4.4). This module NEVER opens the original transcript_path for writing -- only fs.statSync /
// fs.openSync(..., 'r') / fs.readSync are used against it. The archive copy is append-only by
// construction: bytes are only ever appended via fs.appendFileSync, there is no code path here that
// truncates or rewrites either file (AC "アーカイブに削除・編集の経路が存在しない").
import fs from 'node:fs'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { parseJsonlLine, type ParsedJsonlEntry } from '../../shared/jsonl'
import type { ArchiverPort } from '../telemetry/ports'

export interface ArchiverCallbacks {
  onEntries: (sessionId: string, entries: readonly ParsedJsonlEntry[], mtimeMs: number) => void
  onError: (sessionId: string, err: unknown) => void
}

interface WatchState {
  watcher: FSWatcher
  sourcePath: string
  archivePath: string
  offset: number
  parseBuffer: string
}

export class SessionArchiver implements ArchiverPort {
  private readonly sessions = new Map<string, WatchState>()

  constructor(private readonly callbacks: ArchiverCallbacks) {}

  /**
   * Attach to (or, on /resume reopening the same transcript, reattach to) a session's transcript
   * file. Idempotent per sessionId while already attached. On first attach for a brand new session the
   * archive file is created empty and populated purely via the watcher's initial 'add' sync (so the
   * archive always reflects exactly the bytes chokidar observed, never a separate copy step that could
   * race with concurrent writes). On reattach (archive file already exists, e.g. app restarted mid
   * session or /resume), resumes from the existing archive size as the read offset.
   */
  attach(sessionId: string, transcriptPath: string, archiveDir: string): string {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing.archivePath

    fs.mkdirSync(archiveDir, { recursive: true })
    const archivePath = path.join(archiveDir, 'transcript.jsonl')

    let offset = 0
    if (fs.existsSync(archivePath)) {
      offset = fs.statSync(archivePath).size
    } else {
      fs.writeFileSync(archivePath, '')
    }

    const watcher = chokidar.watch(transcriptPath, {
      usePolling: true,
      interval: 100,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
    })
    const state: WatchState = {
      watcher,
      sourcePath: transcriptPath,
      archivePath,
      offset,
      parseBuffer: ''
    }
    this.sessions.set(sessionId, state)

    const sync = (): void => this.syncOnce(sessionId)
    watcher.on('add', sync)
    watcher.on('change', sync)
    watcher.on('error', (err) => this.callbacks.onError(sessionId, err))

    return archivePath
  }

  private syncOnce(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    try {
      const stat = fs.statSync(state.sourcePath)
      if (stat.size < state.offset) {
        this.callbacks.onError(
          sessionId,
          new Error(
            `transcript ${state.sourcePath} shrank from ${state.offset} to ${stat.size} bytes; ` +
              'skipping sync to avoid corrupting the archive'
          )
        )
        return
      }
      if (stat.size === state.offset) return

      const length = stat.size - state.offset
      const buffer = Buffer.alloc(length)
      const fd = fs.openSync(state.sourcePath, 'r')
      try {
        fs.readSync(fd, buffer, 0, length, state.offset)
      } finally {
        fs.closeSync(fd)
      }

      fs.appendFileSync(state.archivePath, buffer)
      state.offset = stat.size

      state.parseBuffer += buffer.toString('utf-8')
      const lines = state.parseBuffer.split('\n')
      state.parseBuffer = lines.pop() ?? ''
      const entries = lines.map(parseJsonlLine).filter((e): e is ParsedJsonlEntry => e !== null)
      if (entries.length > 0) {
        this.callbacks.onEntries(sessionId, entries, stat.mtimeMs)
      }
    } catch (err) {
      this.callbacks.onError(sessionId, err)
    }
  }

  /** Stop watching; the archive file itself is left exactly as-is (append-only -- never deleted). */
  detach(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    void state.watcher.close()
    this.sessions.delete(sessionId)
  }

  detachAll(): void {
    for (const sessionId of [...this.sessions.keys()]) this.detach(sessionId)
  }
}
