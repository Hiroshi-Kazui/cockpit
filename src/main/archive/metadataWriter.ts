// Writes the metadata JSON sidecar for an archived session (spec §4.4: "session_id、ペイン番号、目的
// テキスト、生成タイトル、cwd、開始・終了時刻、使用モデル、累計トークン"). Overwrites its own
// metadata.json on every session update -- this is app-owned derived data, distinct from the
// append-only transcript.jsonl copy archiver.ts maintains, so overwriting it does not violate the
// append-only invariant (spec §4.4's "アーカイブは追記のみ" applies to the transcript, not this
// summary file).
import fs from 'node:fs'
import path from 'node:path'
import type { SessionSummary } from '../../shared/ipc'

export interface SessionMetadata {
  sessionId: string
  pane: number
  purpose: string | null
  title: string | null
  cwd: string | null
  startedAt: number
  endedAt: number | null
  model: string | null
  tokens: {
    in: number
    out: number
    cacheRead: number
    cacheWrite: number
  }
}

/** Pure: shape the DTO written to disk. Exported for unit testing without touching the filesystem. */
export function toMetadata(summary: SessionSummary): SessionMetadata {
  return {
    sessionId: summary.id,
    pane: summary.pane,
    purpose: summary.purpose,
    title: summary.title,
    cwd: summary.cwd,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    model: summary.model,
    tokens: {
      in: summary.tokensIn,
      out: summary.tokensOut,
      cacheRead: summary.tokensCacheRead,
      cacheWrite: summary.tokensCacheWrite
    }
  }
}

export function writeSessionMetadata(archiveDir: string, summary: SessionSummary): void {
  fs.mkdirSync(archiveDir, { recursive: true })
  const metadataPath = path.join(archiveDir, 'metadata.json')
  fs.writeFileSync(metadataPath, JSON.stringify(toMetadata(summary), null, 2), 'utf-8')
}

// M2 FIX (major): statusLine fires on every UI render, so calling writeSessionMetadata synchronously on
// every onSessionUpdated would hammer the main thread with disk I/O at that frequency. This debounces
// in-progress-session writes (coalescing rapid repeated updates for the same session into one write
// `delayMs` after the last one), while writing session-close updates immediately -- ended_at is the
// last thing that matters for a closed session and must never be lost to a debounce window that might
// not fire before the app exits (app quit already flushes everything via flushAll() as a second
// safety net, see main/index.ts's before-quit handler).
export interface DebouncedMetadataWriter {
  /** Schedule (or immediately perform, if the session is now closed) a metadata write. */
  schedule(archiveDir: string, summary: SessionSummary): void
  /** Immediately write and cancel any pending debounced write for one session. */
  flush(sessionId: string): void
  /** Immediately write and cancel every pending debounced write (app quit). */
  flushAll(): void
}

export function createDebouncedMetadataWriter(
  delayMs = 500,
  write: (archiveDir: string, summary: SessionSummary) => void = writeSessionMetadata
): DebouncedMetadataWriter {
  const pending = new Map<
    string,
    { archiveDir: string; summary: SessionSummary; timer: ReturnType<typeof setTimeout> }
  >()

  function cancelPending(sessionId: string): void {
    const existing = pending.get(sessionId)
    if (!existing) return
    clearTimeout(existing.timer)
    pending.delete(sessionId)
  }

  const writer: DebouncedMetadataWriter = {
    schedule(archiveDir, summary) {
      cancelPending(summary.id)
      if (summary.endedAt !== null) {
        write(archiveDir, summary)
        return
      }
      const timer = setTimeout(() => {
        pending.delete(summary.id)
        write(archiveDir, summary)
      }, delayMs)
      pending.set(summary.id, { archiveDir, summary, timer })
    },
    flush(sessionId) {
      const entry = pending.get(sessionId)
      if (!entry) return
      clearTimeout(entry.timer)
      pending.delete(sessionId)
      write(entry.archiveDir, entry.summary)
    },
    flushAll() {
      for (const sessionId of [...pending.keys()]) writer.flush(sessionId)
    }
  }
  return writer
}
