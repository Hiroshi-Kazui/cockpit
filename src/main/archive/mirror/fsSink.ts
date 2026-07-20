// ArchiveSink implementation for a local path or a mounted/synced folder (Google Drive for Desktop,
// OneDrive, Dropbox, etc. -- ADR-0008/D-3 Tier 1 cloud support). Destination directory layout mirrors the
// spool exactly: `<destRoot>/<session_id>/transcript.jsonl` + `metadata.json` (ADR-0008/D-6).
//
// Append-only enforcement lives here (plan.md Phase 2: "追記は「offset 検証 → append」。ミラー先ファイルが
// スプールより大きい場合はエラー状態にして上書きしない"): appendTranscript always re-stats the destination
// file immediately before writing and refuses to proceed (throws) unless its actual size exactly matches
// the caller-supplied offset -- never truncates, never overwrites, never silently skips ahead.
import fs from 'node:fs'
import path from 'node:path'
import { resolveContainedPath } from '../../../shared/paths'
import type { ArchiveSink } from './sink'

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Resolves `<destRoot>/<sessionId>`, refusing (throwing) a session id that would escape destRoot --
 * defense-in-depth mirroring shared/statusline.ts's isValidSessionId whitelist upstream (M2 FIX
 * precedent): session ids reaching this sink already passed that whitelist, but this keeps the invariant
 * enforced at every layer, not just one. */
function sessionDir(destRoot: string, sessionId: string): string {
  const dir = resolveContainedPath(destRoot, sessionId)
  if (!dir) {
    // M8 followup (i18n): Japanese lead sentence + original English preserved in parentheses, matching
    // describeProbeErrno's convention below -- this is a defensive-in-depth path (sessionId already passed
    // the isValidSessionId whitelist upstream) but can still reach `last_error` (via
    // mirrorCoordinator.ts's recordError) and be shown verbatim in the otherwise all-Japanese UI.
    throw new Error(
      `セッションIDがミラー出力先の外を指しているため中止します（refusing to mirror: session id escapes ` +
        `the configured output root: ${sessionId}）`
    )
  }
  return dir
}

export function createFsSink(destRoot: string): ArchiveSink {
  return {
    async statTranscript(sessionId) {
      const file = path.join(sessionDir(destRoot, sessionId), 'transcript.jsonl')
      try {
        const stat = await fs.promises.stat(file)
        return stat.size
      } catch (err) {
        if (isEnoent(err)) return null
        throw err
      }
    },

    async appendTranscript(sessionId, offset, buffer) {
      const dir = sessionDir(destRoot, sessionId)
      await fs.promises.mkdir(dir, { recursive: true })
      const file = path.join(dir, 'transcript.jsonl')

      let currentSize = 0
      try {
        currentSize = (await fs.promises.stat(file)).size
      } catch (err) {
        if (!isEnoent(err)) throw err
      }

      if (currentSize !== offset) {
        // M8 followup (i18n): Japanese lead sentence + original English preserved in parentheses (same
        // convention as sessionDir's throw above and describeProbeErrno below) -- this append-only guard
        // failure is exactly the kind of failure recordError surfaces verbatim as `last_error` in the UI.
        throw new Error(
          `ミラー先のファイルサイズが想定と一致しないため書き込みを中止します（append-only 違反ガード）` +
            `（mirror destination transcript for session ${sessionId} is ${currentSize} bytes, expected ` +
            `${offset} bytes at append time; refusing to write (append-only violation guard)）`
        )
      }

      const handle = await fs.promises.open(file, 'a')
      try {
        await handle.appendFile(buffer)
      } finally {
        await handle.close()
      }
    },

    async writeMetadata(sessionId, json) {
      const dir = sessionDir(destRoot, sessionId)
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.writeFile(path.join(dir, 'metadata.json'), json, 'utf-8')
    },

    async readTranscriptPrefix(sessionId, length) {
      if (length === 0) return Buffer.alloc(0)
      const file = path.join(sessionDir(destRoot, sessionId), 'transcript.jsonl')
      const handle = await fs.promises.open(file, 'r')
      try {
        const buffer = Buffer.alloc(length)
        // M7 followup (bytesRead validation): fs.read()'s `bytesRead` is not guaranteed to equal the
        // requested `length` (e.g. the file is shorter than expected -- concurrent modification, or a
        // caller miscalculating the requested window). Node.js does NOT zero-fill or reject a short read on
        // its own -- silently returning a partially-filled buffer would make mirrorCoordinator.ts's
        // rebaselineSession content-prefix comparison compare against trailing zero bytes that were never
        // actually read, which could produce a false match/mismatch instead of a clear I/O-level signal.
        const { bytesRead } = await handle.read(buffer, 0, length, 0)
        if (bytesRead !== length) {
          // M8 followup (i18n): Japanese lead sentence + original English preserved in parentheses.
          throw new Error(
            `ミラー先の読み取りバイト数が不足しています（宛先が同時に変更された可能性があります）` +
              `（short read at ${file}: expected ${length} byte(s), got ${bytesRead}）`
          )
        }
        return buffer
      } finally {
        await handle.close()
      }
    }
  }
}

/** M7 followup (i18n): translates a raw Node.js fs errno (EACCES, ENOSPC, ...) into a Japanese lead
 * sentence for probeWritable's user-facing `reason` below -- the UI is otherwise entirely Japanese, so a
 * bare English/errno string here ("EACCES: permission denied, mkdir '...'") reads as broken/untranslated.
 * The original message is still appended in parentheses (not dropped) for anyone who needs the concrete
 * diagnostic detail (support, bug reports). */
function describeProbeErrno(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'アクセス権限がありません'
    case 'ENOENT':
      return '指定されたパスが見つかりません'
    case 'ENOTDIR':
      return '指定されたパスはフォルダではありません'
    case 'ENOSPC':
      return '空き容量が不足しています'
    case 'EROFS':
      return '読み取り専用のため書き込めません'
    default:
      return '書き込みに失敗しました'
  }
}

/** D-5: "出力先はプローブ（一時ファイル作成→削除）で検証" -- called from the archiveOutputRootSet IPC
 * handler before persisting a new output root, so an unwritable destination (permission denied, disk
 * full, cloud folder not actually mounted) is reported as a typed validation failure instead of only
 * surfacing later as a silent mirror-sync error. */
export async function probeWritable(
  root: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await fs.promises.mkdir(root, { recursive: true })
    const probePath = path.join(root, `.cockpit-probe-${process.pid}-${Date.now()}`)
    await fs.promises.writeFile(probePath, '')
    await fs.promises.unlink(probePath)
    return { ok: true }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `出力先に書き込めません: ${describeProbeErrno(err)}（${detail}）` }
  }
}
