// Read-only helpers over the spool archive (userData/archive, the record of truth -- ADR-0008/D-2) used
// by mirrorCoordinator.ts to source bytes/content for the destination mirror. Every function here only
// ever opens a file for reading (`fs.promises.open(path, 'r')`/`readFile`/`stat`/`readdir`) -- never for
// writing -- so mirroring can never itself become a path that corrupts or truncates the spool (the
// append-only write path into the spool remains archiver.ts/metadataWriter.ts's exclusive responsibility,
// unchanged by this milestone).
import fs from 'node:fs'
import path from 'node:path'
import { resolveContainedPath } from '../../../shared/paths'

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

export interface SpoolReader {
  /** Current size (bytes) of the spool's transcript.jsonl copy for a session, or null if this session has
   * no archived transcript yet (statusLine seen but no JSONL activity synced yet, or an unknown id). */
  statSpoolTranscript(sessionId: string): Promise<number | null>
  /** Reads exactly `length` bytes starting at `offset` from the spool's transcript.jsonl copy. */
  readSpoolBytes(sessionId: string, offset: number, length: number): Promise<Buffer>
  /** Reads the spool's metadata.json sidecar content, or null if it does not exist yet. */
  readSpoolMetadata(sessionId: string): Promise<string | null>
  /** Enumerates every session id currently present under the spool root (one subdirectory per session,
   * spec §4.4) -- used for output-root-change rebaselining and explicit backfill (both need "every known
   * session", not just ones already tracked in archive_mirror). */
  listSpoolSessionIds(): string[]
}

export function createSpoolReader(spoolRoot: string): SpoolReader {
  function sessionDir(sessionId: string): string | null {
    return resolveContainedPath(spoolRoot, sessionId)
  }

  return {
    async statSpoolTranscript(sessionId) {
      const dir = sessionDir(sessionId)
      if (!dir) return null
      try {
        const stat = await fs.promises.stat(path.join(dir, 'transcript.jsonl'))
        return stat.size
      } catch (err) {
        if (isEnoent(err)) return null
        throw err
      }
    },

    async readSpoolBytes(sessionId, offset, length) {
      const dir = sessionDir(sessionId)
      if (!dir) {
        throw new Error(`invalid session id for spool read: ${sessionId}`)
      }
      if (length === 0) return Buffer.alloc(0)
      const file = path.join(dir, 'transcript.jsonl')
      const handle = await fs.promises.open(file, 'r')
      try {
        const buffer = Buffer.alloc(length)
        // M7 followup (bytesRead validation) -- see fsSink.ts's readTranscriptPrefix for why a short read
        // must be a thrown error, not a silently zero-padded buffer.
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        if (bytesRead !== length) {
          throw new Error(
            `short read from spool transcript for session ${sessionId} at ${file}: expected ${length} ` +
              `byte(s) at offset ${offset}, got ${bytesRead} (the spool may have changed concurrently)`
          )
        }
        return buffer
      } finally {
        await handle.close()
      }
    },

    async readSpoolMetadata(sessionId) {
      const dir = sessionDir(sessionId)
      if (!dir) return null
      try {
        return await fs.promises.readFile(path.join(dir, 'metadata.json'), 'utf-8')
      } catch (err) {
        if (isEnoent(err)) return null
        throw err
      }
    },

    listSpoolSessionIds() {
      try {
        return fs
          .readdirSync(spoolRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      } catch (err) {
        if (isEnoent(err)) return []
        throw err
      }
    }
  }
}
