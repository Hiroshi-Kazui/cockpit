// Watches a linked transcript JSONL file and mirrors newly-appended, *retained* lines into the
// app-managed archive (spec §4.4/§4.4.1, ADR-0011: M10 selects only lines useful for later analysis --
// see shared/archiveRetention.ts for the pure policy). This module NEVER opens the original
// transcript_path for writing -- only fs.statSync / fs.openSync(..., 'r') / fs.readSync are used against
// it. The archive copy is append-only by construction: bytes are only ever appended via
// fs.appendFileSync, there is no code path here that truncates or rewrites either file (AC "アーカイブに
// 削除・編集の経路が存在しない").
//
// Because retention makes the archive smaller than the source it was read from, "archive size == bytes
// already read from source" (the pre-M10 invariant) no longer holds. A per-session sidecar file
// (`archive-state.json`, `{ sourceOffset, lastUuid }`, written temp+rename) persists the *confirmed* source
// read offset independently -- confirmed meaning "up to here, every byte has been resolved into either a
// retained (archived) or discarded line; nothing left half-read" -- and is validated against the archive's
// own content before being trusted on re-attach (ADR-0011/D-4; shared/archiveRetention.ts's
// `decideResumeOffset`/`ArchiveAnchor`).
import fs from 'node:fs'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { parseJsonlLine, type ParsedJsonlEntry } from '../../shared/jsonl'
import {
  decideResumeOffset,
  extractUuid,
  lastRetainedUuid,
  parseSidecar,
  shouldRetainLine,
  type ArchiveAnchor,
  type ResumeSidecar
} from '../../shared/archiveRetention'
import type { ArchiverPort } from '../telemetry/ports'

export interface ArchiverCallbacks {
  onEntries: (sessionId: string, entries: readonly ParsedJsonlEntry[], mtimeMs: number) => void
  onError: (sessionId: string, err: unknown) => void
}

const NEWLINE_BYTE = 0x0a
const NEWLINE = Buffer.from('\n')

/** Bound on how many bytes any single read/process step (initial catch-up sync, or the resume-offset
 * scan) handles at once. Major fix: attaching to a large pre-existing session used to read and process the
 * *entire* unread region in one synchronous pass (a single `Buffer.alloc(stat.size - readOffset)` plus one
 * decode/split/filter/join pass over it) -- measured at ~139ms blocking the event loop for a 27MB /
 * 6,735-line transcript, which would only get worse for a 100MB+ `/resume`d session. Both `syncOnce` and
 * `scanSourceForLastUuidOffset` now loop in these fixed-size windows instead. */
const CHUNK_SIZE = 1024 * 1024

interface WatchState {
  watcher: FSWatcher
  sourcePath: string
  archivePath: string
  sidecarPath: string
  /** Source byte offset up to which every byte has been resolved into a complete line (retained or
   * discarded) -- excludes whatever tail bytes `parseBuffer` is currently holding as an incomplete line.
   * This, not "total bytes read", is what gets persisted to the sidecar (B1 fix: the pre-fix code
   * persisted the *read* cursor, including an in-flight partial line's bytes, which then vanished forever
   * on the next reattach since `parseBuffer` always restarts empty). */
  confirmedSourceOffset: number
  /** Bytes read past `confirmedSourceOffset` that do not yet form a complete line (no trailing '\n' seen
   * yet). Held as a `Buffer`, not a `string` (B1 fix): decoding an in-progress chunk to UTF-8 text before
   * its continuation arrives can turn a multi-byte character split across the chunk boundary into a
   * lossy U+FFFD replacement, which would then be archived verbatim -- violating R-4's byte-identical
   * guarantee. Concatenating as raw bytes first and decoding only once a line is complete avoids this. */
  parseBuffer: Buffer
  /** `uuid` of the last line actually appended to the archive, or null if none has been appended yet (or
   * the last appended line had no `uuid`). Mirrors what is persisted in the sidecar. */
  lastUuid: string | null
}

/** The outcome of reading the resume sidecar file (C1 fix, requirement #2): distinguishes a genuinely
 * missing file from one that is present but failed to parse/validate -- see `readSidecarOutcome`'s doc
 * comment on `SessionArchiver` for why this distinction matters. */
type SidecarReadOutcome =
  | { kind: 'absent' }
  | { kind: 'invalid'; error: unknown }
  | { kind: 'present'; sidecar: ResumeSidecar }

/** Writes `data` to `path` via a temp file + rename in the same directory, so a crash mid-write never
 * leaves a partially-written file for a later reader to choke on (ADR-0011/D-4, R-6). */
function writeFileAtomic(filePath: string, data: string): void {
  const dir = path.dirname(filePath)
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmpPath, data, 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

/** Reads the archive file's own content, backward from the end in bounded, exponentially-growing windows
 * (never loading the whole file into memory when the answer is near the tail, which it always is in
 * ordinary operation -- fix for the "attach 時の同期フル読み込み" review finding), to determine its
 * `ArchiveAnchor` (ADR-0011/D-4, B2 fix): whether it's empty, ends on a line with a `uuid`, or has content
 * but no `uuid` anywhere. Walking backward past blank lines *and* past lines that lack a `uuid` (skipping
 * them rather than stopping at the very last line) is what B2 requires: the true anchor is the last line
 * that actually carries a `uuid`, not necessarily the file's literal last line. */
function readArchiveAnchor(archivePath: string): ArchiveAnchor {
  if (!fs.existsSync(archivePath)) return { kind: 'empty' }
  const size = fs.statSync(archivePath).size
  if (size === 0) return { kind: 'empty' }

  const fd = fs.openSync(archivePath, 'r')
  try {
    let windowSize = Math.min(size, 64 * 1024)
    while (true) {
      const buf = Buffer.alloc(windowSize)
      const bytesRead = fs.readSync(fd, buf, 0, windowSize, size - windowSize)
      const text = buf.subarray(0, bytesRead).toString('utf-8')
      const windowCoversWholeFile = windowSize >= size
      const rawLines = text.split('\n')
      // Unless the window covers the whole file, the first element may be a fragment of a line that
      // started before the window began -- drop it so a truncated line's tail is never mistaken for a
      // whole line (the same carry-over discipline syncOnce itself follows).
      const usableLines = windowCoversWholeFile ? rawLines : rawLines.slice(1)
      for (let i = usableLines.length - 1; i >= 0; i -= 1) {
        const candidate = usableLines[i].trim()
        if (candidate.length === 0) continue
        const uuid = extractUuid(candidate)
        if (uuid !== null) return { kind: 'uuid', uuid }
        // A non-blank line with no uuid (e.g. an unknown-type R-5 line) -- keep walking backward past it.
      }
      if (windowCoversWholeFile) return { kind: 'noUuid' }
      windowSize = Math.min(size, windowSize * 4)
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** Reads up to `length` bytes starting at absolute byte `position`, writing into `buffer` starting at
 * index 0, and returns the number of bytes actually read (may be less than `length` at EOF) -- the same
 * contract `fs.readSync` has. Abstracts the byte source so the scanning logic below can be driven by a
 * real file descriptor in production or an in-memory buffer in tests. */
export type ChunkReader = (position: number, buffer: Buffer, length: number) => number

/**
 * Scans a byte source of `totalSize` bytes (read via `readChunk` in bounded `CHUNK_SIZE` windows, never
 * loading the whole source into memory at once) for the *last* line whose `uuid` equals `targetUuid` (B2
 * fix: a duplicate uuid must resolve to the last occurrence, or resuming just past the first one would
 * re-append every retained line between it and the true last occurrence). Returns the byte offset
 * immediately after that line's own trailing newline, or null if `targetUuid` never appears anywhere.
 *
 * Pure with respect to I/O (all reads go through the injected `readChunk`), which is what major-fix #3
 * exploits: this used to be inline inside the impure `scanSourceForLastUuidOffset` below with no unit test
 * of its own -- the only unit-tested equivalent was `shared/archiveRetention.ts`'s `findResumeOffsetByUuid`,
 * a *different, simpler* (whole-string, non-chunked) implementation that production code never actually
 * called. That left the resume-critical scan split across "tested but not run in production" and "run in
 * production but untested" -- removed `findResumeOffsetByUuid` and moved its test coverage here, onto the
 * implementation that is actually exercised, now additionally exercised with a deliberately tiny chunk
 * size so a uuid line spanning a chunk boundary is covered too (untested by the old string-based fixture).
 */
export function scanChunksForLastUuidOffset(
  readChunk: ChunkReader,
  totalSize: number,
  targetUuid: string,
  chunkSize: number = CHUNK_SIZE
): number | null {
  let readPos = 0
  let pending = Buffer.alloc(0)
  // Absolute byte offset in the source at which `pending`'s first byte sits.
  let pendingStartOffset = 0
  let lastMatchOffset: number | null = null

  while (readPos < totalSize) {
    const length = Math.min(chunkSize, totalSize - readPos)
    const buf = Buffer.alloc(length)
    const bytesRead = readChunk(readPos, buf, length)
    if (bytesRead === 0) break
    readPos += bytesRead

    const combined = Buffer.concat([pending, buf.subarray(0, bytesRead)])
    let lineStart = 0
    while (true) {
      const newlineIndex = combined.indexOf(NEWLINE_BYTE, lineStart)
      if (newlineIndex === -1) break
      const lineBytes = combined.subarray(lineStart, newlineIndex)
      if (extractUuid(lineBytes.toString('utf-8')) === targetUuid) {
        lastMatchOffset = pendingStartOffset + newlineIndex + 1
      }
      lineStart = newlineIndex + 1
    }
    pending = Buffer.from(combined.subarray(lineStart))
    pendingStartOffset += lineStart
  }
  return lastMatchOffset
}

/** Thin `fs` wrapper around `scanChunksForLastUuidOffset` -- scans `sourcePath` forward from byte 0 for
 * `targetUuid`. Returns null if the file does not exist. */
function scanSourceForLastUuidOffset(sourcePath: string, targetUuid: string): number | null {
  if (!fs.existsSync(sourcePath)) return null
  const fd = fs.openSync(sourcePath, 'r')
  try {
    const size = fs.fstatSync(fd).size
    return scanChunksForLastUuidOffset(
      (position, buffer, length) => fs.readSync(fd, buffer, 0, length, position),
      size,
      targetUuid
    )
  } finally {
    fs.closeSync(fd)
  }
}

/** C1 fix, requirement #4: structurally refuses to ever start reading from a byte offset that does not
 * land exactly on a source line boundary (offset 0, or immediately after a '\n' byte) -- the concrete
 * failure mode this guards against is exactly the removed `legacyArchiveSize` bug (adopting an offset with
 * no proven relationship to any line boundary in the source, silently corrupting the next read with a
 * mid-line fragment). Every existing decision path (`zero`, `scan`, and a `sidecar` whose offset was
 * itself always computed at a confirmed line boundary by `syncOnce`) already satisfies this by
 * construction; this check exists so that never stops being true, even if a future change to the resume
 * logic gets it wrong again. Returns false (never throws) if the source is missing or shorter than
 * `offset`, since a boundary can't be confirmed in either case. */
function isSourceOffsetAtLineBoundary(sourcePath: string, offset: number): boolean {
  if (offset === 0) return true
  if (!fs.existsSync(sourcePath)) return false
  const size = fs.statSync(sourcePath).size
  if (offset > size) return false
  const fd = fs.openSync(sourcePath, 'r')
  try {
    const buf = Buffer.alloc(1)
    const bytesRead = fs.readSync(fd, buf, 0, 1, offset - 1)
    return bytesRead === 1 && buf[0] === NEWLINE_BYTE
  } finally {
    fs.closeSync(fd)
  }
}

export class SessionArchiver implements ArchiverPort {
  private readonly sessions = new Map<string, WatchState>()

  constructor(private readonly callbacks: ArchiverCallbacks) {}

  /**
   * Attach to (or, on /resume reopening the same transcript, reattach to) a session's transcript
   * file. Idempotent per sessionId while already attached. On first attach for a brand new session the
   * archive file is created empty and populated purely via the watcher's initial 'add' sync (so the
   * archive always reflects exactly the retained lines chokidar observed, never a separate copy step
   * that could race with concurrent writes). On reattach, the source read offset is recovered via
   * `decideResumeOffset` (ADR-0011/D-4, B2). If no safe anchor exists (`decision.kind === 'unsafe'`), this
   * session is deliberately left un-watched -- the same safe-stop precedent ADR-0009 uses for a confirmed
   * mirror mismatch -- and the anomaly is reported via `onError` instead of guessing (which could silently
   * duplicate or lose archived content).
   */
  attach(sessionId: string, transcriptPath: string, archiveDir: string): string {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing.archivePath

    fs.mkdirSync(archiveDir, { recursive: true })
    const archivePath = path.join(archiveDir, 'transcript.jsonl')
    const sidecarPath = path.join(archiveDir, 'archive-state.json')
    if (!fs.existsSync(archivePath)) fs.writeFileSync(archivePath, '')

    const archiveAnchor = readArchiveAnchor(archivePath)
    const sidecarOutcome = this.readSidecarOutcome(sidecarPath)
    if (sidecarOutcome.kind === 'invalid') {
      // R-6: never swallowed -- reported before degrading to "treat as no sidecar" below.
      this.callbacks.onError(sessionId, sidecarOutcome.error)
    }
    const sidecar = sidecarOutcome.kind === 'present' ? sidecarOutcome.sidecar : null
    const decision = decideResumeOffset({ sidecar, archiveAnchor })

    let confirmedSourceOffset: number
    let lastUuid: string | null
    switch (decision.kind) {
      case 'sidecar':
        confirmedSourceOffset = decision.sourceOffset
        lastUuid = archiveAnchor.kind === 'uuid' ? archiveAnchor.uuid : null
        break
      case 'scan':
        confirmedSourceOffset = this.recoverOffsetByScanning(
          sessionId,
          transcriptPath,
          decision.targetUuid
        )
        lastUuid = decision.targetUuid
        break
      case 'zero':
        confirmedSourceOffset = 0
        lastUuid = null
        break
      case 'unsafe':
        this.reportUnsafe(sessionId, transcriptPath, decision.reason)
        return archivePath
    }

    // C1 fix, requirement #4: never start watching/reading from an offset that isn't a confirmed source
    // line boundary, regardless of which branch above computed it -- see isSourceOffsetAtLineBoundary's
    // doc comment.
    if (!isSourceOffsetAtLineBoundary(transcriptPath, confirmedSourceOffset)) {
      this.reportUnsafe(
        sessionId,
        transcriptPath,
        `computed resume offset ${confirmedSourceOffset} (via decision '${decision.kind}') does not land ` +
          'on a source line boundary'
      )
      return archivePath
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
      sidecarPath,
      confirmedSourceOffset,
      parseBuffer: Buffer.alloc(0),
      lastUuid
    }
    this.sessions.set(sessionId, state)

    const sync = (): void => this.syncOnce(sessionId)
    watcher.on('add', sync)
    watcher.on('change', sync)
    watcher.on('error', (err) => this.callbacks.onError(sessionId, err))

    return archivePath
  }

  /** Reads the sidecar file, distinguishing "no file at all" from "file present but malformed/invalid"
   * (C1 fix, requirement #2): the two used to both collapse into a bare `null`, which meant a genuinely
   * missing sidecar (e.g. a pre-M10 archive, or a brand-new session) and a *corrupted* one (e.g. a crash
   * mid-write that somehow escaped the temp+rename discipline, or external disk corruption) were
   * indistinguishable to every caller -- including the now-removed `legacyArchiveSize` branch, which
   * treated a corrupted sidecar exactly like a legitimate pre-M10 archive. Callers still fold `invalid`
   * into "treat as no sidecar" for `decideResumeOffset` today (both degrade the same way there), but the
   * type now makes that folding an explicit choice at the call site rather than an unavoidable collapse
   * here, and `invalid` carries the actual parse error for `onError` reporting. */
  private readSidecarOutcome(sidecarPath: string): SidecarReadOutcome {
    if (!fs.existsSync(sidecarPath)) return { kind: 'absent' }
    try {
      return { kind: 'present', sidecar: parseSidecar(fs.readFileSync(sidecarPath, 'utf-8')) }
    } catch (err) {
      return { kind: 'invalid', error: err }
    }
  }

  /** C3 fix: the `unsafe` decision used to surface an English, developer-oriented message containing the
   * transcript's absolute path, whose only remediation instruction ("fix or remove archive-state.json /
   * the archive to retry") actively caused the very corruption this milestone's C1 fix closes (deleting
   * the sidecar of a selectively-retained archive used to make `legacyArchiveSize` adopt the archive's
   * byte size as a bogus source offset) -- and, for the `noUuid`-without-matching-sidecar shape, following
   * that instruction never actually resolves anything (the archive still has no uuid to anchor on after
   * deleting the sidecar), so the same dead-end banner would resurface forever. The user-facing message
   * here is therefore Japanese, names no file path, and explicitly tells the user *not* to touch the
   * archive's files -- the only safe next step is to start a fresh session and report the session to a
   * developer. The full diagnostic (path + `decision.reason`) is preserved as the `Error`'s `cause` so it
   * still reaches the console/log (`SessionCoordinator.onArchiverError`'s `console.error` prints it) for
   * whoever investigates, without it leaking into the text shown in the app. */
  private reportUnsafe(sessionId: string, transcriptPath: string, reason: string): void {
    this.callbacks.onError(
      sessionId,
      new Error(
        'このセッションのアーカイブ記録を停止しました。アプリを再起動しても復旧しません。' +
          '新しいセッションを開いて作業を続けてください。このセッションのアーカイブファイル' +
          '（archive-state.json や transcript.jsonl）は削除・変更せず、開発者に報告してください。',
        { cause: new Error(`cannot safely resume archiving for ${transcriptPath}: ${reason}`) }
      )
    )
  }

  /** Scans the source transcript in bounded chunks for `targetUuid` (the archive's chosen anchor line's
   * uuid) to recover the correct `confirmedSourceOffset` when the sidecar is missing or stale
   * (ADR-0011/D-4). If `targetUuid` is not found anywhere (e.g. the source was rotated/replaced), reports
   * the anomaly via `onError` and falls back to byte 0 -- re-appending already-archived lines duplicates
   * data but never loses it, the deliberate tradeoff this milestone's plan (§3, D-4) takes. */
  private recoverOffsetByScanning(
    sessionId: string,
    transcriptPath: string,
    targetUuid: string
  ): number {
    try {
      const found = scanSourceForLastUuidOffset(transcriptPath, targetUuid)
      if (found !== null) return found
    } catch (err) {
      this.callbacks.onError(sessionId, err)
      return 0
    }
    this.callbacks.onError(
      sessionId,
      new Error(
        `could not locate uuid ${targetUuid} (the archive's resume anchor) anywhere in ${transcriptPath} ` +
          'while recovering the resume offset; resuming from byte 0 instead (may re-append ' +
          'already-archived lines, but will never lose new ones)'
      )
    )
    return 0
  }

  /** Splits `bytes` into individual line buffers on the raw newline *byte* (0x0a), before any UTF-8
   * decoding -- minor fix: 0x0a is never a continuation byte inside a valid multi-byte UTF-8 sequence, so
   * this boundary is safe to find even when a line's own bytes happen not to be valid UTF-8. Decoding to a
   * string (unavoidable for `shouldRetainLine`/`parseJsonlLine`, which need to `JSON.parse` it) happens
   * per-line and only for *reading* the line's content, never for what gets written back to the archive --
   * see the R-4 comment at the `appendFileSync` call site below for why that distinction matters. `bytes`
   * itself never contains a trailing newline (the caller always slices up to, not through, the last '\n'),
   * so this always returns exactly one more element than there are '\n' bytes in it. */
  private static splitLines(bytes: Buffer): Buffer[] {
    const result: Buffer[] = []
    let start = 0
    while (true) {
      const index = bytes.indexOf(NEWLINE_BYTE, start)
      if (index === -1) {
        result.push(bytes.subarray(start))
        return result
      }
      result.push(bytes.subarray(start, index))
      start = index + 1
    }
  }

  /** Processes exactly one bounded chunk (at most `CHUNK_SIZE` bytes) of newly-available source bytes for
   * an already-open source file descriptor: reads, splits into complete lines, appends the retained ones,
   * reports parsed entries, and persists the sidecar. Returns `false` once there is nothing left to read
   * (caller should stop looping), `true` if it made progress and there may be more (caller should call
   * again). Extracted out of `syncOnce` (major fix #2) so a single fs-change event on a large pre-existing
   * transcript processes it in fixed-size windows instead of one `Buffer.alloc(entire unread region)` plus
   * one decode/split/filter/join pass over it -- measured at ~139ms of event-loop blocking for a 27MB /
   * 6,735-line transcript before this fix. */
  private syncChunk(
    sessionId: string,
    state: WatchState,
    fd: number,
    targetSize: number,
    mtimeMs: number
  ): boolean {
    const readOffset = state.confirmedSourceOffset + state.parseBuffer.length
    if (targetSize < readOffset) {
      this.callbacks.onError(
        sessionId,
        new Error(
          `transcript ${state.sourcePath} shrank from ${readOffset} to ${targetSize} bytes; ` +
            'skipping sync to avoid corrupting the archive'
        )
      )
      return false
    }
    if (targetSize === readOffset) return false

    const length = Math.min(CHUNK_SIZE, targetSize - readOffset)
    const chunk = Buffer.alloc(length)
    // Fix: the return value (actual bytes read) is captured and used everywhere below instead of assuming
    // a short read never happens -- a short read used to leave the unread tail of `chunk` as NUL bytes
    // (Buffer.alloc's zero-fill) that got archived verbatim as part of the "line".
    const bytesRead = fs.readSync(fd, chunk, 0, length, readOffset)
    if (bytesRead === 0) return false
    const newBytes = chunk.subarray(0, bytesRead)

    const combined = Buffer.concat([state.parseBuffer, newBytes])
    const lastNewlineIndex = combined.lastIndexOf(NEWLINE_BYTE)
    if (lastNewlineIndex === -1) {
      // No complete line yet in this chunk -- carry everything forward. `confirmedSourceOffset` is
      // deliberately left untouched (B1 fix): nothing has been confirmed yet, so nothing new is persisted
      // to the sidecar either.
      state.parseBuffer = combined
      return bytesRead === length && readOffset + bytesRead < targetSize
    }

    const completeBytes = combined.subarray(0, lastNewlineIndex)
    state.parseBuffer = Buffer.from(combined.subarray(lastNewlineIndex + 1))
    // `readOffset + bytesRead` is the absolute file position just past everything read so far (confirmed +
    // still-pending); subtracting the new pending length yields exactly the offset up to which lines are
    // now fully resolved -- the same invariant `confirmedSourceOffset + parseBuffer.length === (bytes read
    // from the file so far)` holds before and after this line.
    state.confirmedSourceOffset = readOffset + bytesRead - state.parseBuffer.length

    const lineBuffers = SessionArchiver.splitLines(completeBytes)
    const lineTexts = lineBuffers.map((b) => b.toString('utf-8'))

    const retainedLineBuffers = lineBuffers.filter((_buf, i) => shouldRetainLine(lineTexts[i]))
    if (retainedLineBuffers.length > 0) {
      // R-4: append the retained lines' exact original *bytes*, never re-serialized and never round-tripped
      // through a decoded string (minor fix: `toString('utf-8')` followed by re-encoding on
      // `appendFileSync(string, ...)` would silently replace an invalid UTF-8 byte in the source with
      // U+FFFD, breaking byte-identical fidelity for that one pathological case -- these are the original
      // `Buffer` slices straight out of `combined`).
      const withNewlines = retainedLineBuffers.flatMap((b) => [b, NEWLINE])
      fs.appendFileSync(state.archivePath, Buffer.concat(withNewlines))
      const retainedTexts = retainedLineBuffers.map((b) => b.toString('utf-8'))
      // C2 fix: scans the newly-retained lines backward for the last one that carries a uuid, falling back
      // to the *existing* `state.lastUuid` (not null) if none of them do -- otherwise a batch whose last
      // retained line happens to be an R-5 uuid-less tolerant-fallback line would regress `lastUuid` to
      // null even though an earlier line already established one, disagreeing with `readArchiveAnchor`'s
      // own backward skip-past-uuid-less-lines logic and causing a spurious `scan` resume that re-appends
      // that trailing line on every future reattach.
      state.lastUuid = lastRetainedUuid(retainedTexts, state.lastUuid)
    }

    // Report the parsed entries before persisting the sidecar (fix: previously a sidecar write exception
    // -- e.g. a full disk -- would throw out of this function before onEntries ever fired, silently
    // dropping the token/purpose-detection accounting for lines already durably appended to the archive
    // above).
    const entries = lineTexts.map(parseJsonlLine).filter((e): e is ParsedJsonlEntry => e !== null)
    if (entries.length > 0) {
      this.callbacks.onEntries(sessionId, entries, mtimeMs)
    }

    try {
      // D-4: append first, persist the sidecar second -- a crash in between leaves `lastUuid` stale, which
      // decideResumeOffset's mismatch branch (R-6) recovers from by scanning, never by losing data.
      writeFileAtomic(
        state.sidecarPath,
        JSON.stringify({ sourceOffset: state.confirmedSourceOffset, lastUuid: state.lastUuid })
      )
    } catch (err) {
      this.callbacks.onError(sessionId, err)
    }

    return state.confirmedSourceOffset + state.parseBuffer.length < targetSize
  }

  private syncOnce(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    let fd: number | null = null
    try {
      const stat = fs.statSync(state.sourcePath)
      fd = fs.openSync(state.sourcePath, 'r')
      // Loop in bounded CHUNK_SIZE windows (major fix #2) until either nothing is left to read/process, or
      // a chunk step itself decides to stop (source shrank, or no new complete line yet).
      while (this.syncChunk(sessionId, state, fd, stat.size, stat.mtimeMs)) {
        // continue
      }
    } catch (err) {
      this.callbacks.onError(sessionId, err)
    } finally {
      if (fd !== null) fs.closeSync(fd)
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
