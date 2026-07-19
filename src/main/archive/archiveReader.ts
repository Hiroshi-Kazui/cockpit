// Reads an already-archived session transcript for the M5 read-only past-session viewer (spec §4.4).
// This is the only module allowed to open an archived transcript.jsonl for reading on the renderer's
// behalf -- the archive-browsing IPC handler (main/ipc/handlers.ts, via main/archive/archiveBrowser.ts)
// delegates here rather than letting any other module touch archive files directly. Read-only by
// construction: the only fs calls here are realpath/readFile; there is no write/unlink path (AC "閲覧は
// 読み取り専用。アーカイブへの編集・削除UIが存在しない" -- this module is the main-side half of that
// guarantee).
import fs from 'node:fs'
import { parseJsonlLineForDisplay, type JsonlDisplayTurn } from '../../shared/jsonl'
import { resolveContainedPath } from '../../shared/paths'

/** Thrown for any failure reading an archived transcript (containment violation or fs error), so the IPC
 * handler can surface a single well-typed, user-visible reason string instead of an opaque native error
 * object (silent failure is prohibited). */
export class ArchiveTranscriptReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveTranscriptReadError'
  }
}

/** M5 FIX (deferred item 2): upper bound on the number of turns handed back to the renderer per session
 * read. Archived transcripts can grow to many thousands of turns/several MB in real use. This bound does
 * NOT reduce the read/parse cost below -- `readFile` still loads the whole file and every line is still
 * parsed before this cap is applied, so that part stays O(file) regardless. What it bounds is what leaves
 * this function: the IPC payload sent to the renderer, the array kept in SessionBrowser's React state, and
 * the DOM nodes rendered from it -- the actual unbounded-work risk for a feature that only needs to
 * *display* the conversation, not stream/paginate it (that would be over-engineering for M5's read-only
 * viewer; YAGNI until a real transcript is shown to make readFile itself the bottleneck). When a transcript
 * exceeds this, the OLDEST turns are dropped and the newest MAX_DISPLAY_TURNS are kept (a viewer cares most
 * about the most recent exchanges) -- never silently: see shared/ipc.ts's
 * ArchiveReadSessionResult.truncated/omittedCount, which this module's result reports and which the
 * SessionBrowser UI renders as an explicit notice. */
export const MAX_DISPLAY_TURNS = 500

export interface ReadArchivedTranscriptResult {
  turns: JsonlDisplayTurn[]
  truncated: boolean
  omittedCount: number
}

/** Injectable fs seam so archiveReader.test.ts can exercise the symlink-escape containment recheck below
 * without needing to actually create a filesystem symlink -- Windows symlink creation requires elevated
 * privileges/Developer Mode that is not guaranteed available wherever this test suite runs (M5 FIX,
 * deferred item 1). Defaults to the real `node:fs/promises` functions in production. */
export interface ArchiveReaderDeps {
  /** Resolves a path to its canonical, symlink-free real path (`fs.promises.realpath`). */
  realpath: (path: string) => Promise<string>
  /** Reads a file's full contents as utf-8 text (`fs.promises.readFile`). */
  readFile: (path: string) => Promise<string>
}

const defaultDeps: ArchiveReaderDeps = {
  realpath: (path) => fs.promises.realpath(path),
  readFile: (path) => fs.promises.readFile(path, 'utf-8')
}

/**
 * Reads and parses `jsonlPath` into display turns (chronological, transcript order), capped at
 * MAX_DISPLAY_TURNS (oldest dropped first).
 *
 * Defense-in-depth, layer 1 (same pattern as main/index.ts's archiveDirFor / shared/paths.ts's
 * resolveContainedPath, M2 FIX security): `jsonlPath` originates from the `sessions.jsonl_path` DB
 * column, which this app itself writes (main/telemetry/sessionCoordinator.ts always derives it from
 * `archiveDirFor`'s already-contained result) -- so in normal operation it can never point outside
 * `archiveRoot`. `resolveContainedPath` (string-based, path.resolve/path.relative) is reused unchanged
 * here as a second, independent layer in case that row were ever corrupted or hand-edited outside the
 * app.
 *
 * Defense-in-depth, layer 2 (M5 FIX, deferred item 1): a purely string-based containment check can be
 * defeated by a symlink somewhere under `archiveRoot` that points outside it -- `path.resolve`/
 * `path.relative` never touch the filesystem, so they cannot see that. Once layer 1 accepts the path,
 * this resolves both `archiveRoot` and the candidate file to their canonical real paths (`realpath`,
 * which *does* follow symlinks) and re-checks containment against those. In this app's actual write path
 * there is no renderer-supplied path and no symlink is ever created under the archive root, so this is
 * pure defense-in-depth against a hand-placed/corrupted symlink, not a reachable attack from the
 * renderer -- see archiveBrowser.ts's header comment for the same caveat on layer 1.
 */
export async function readArchivedTranscript(
  archiveRoot: string,
  jsonlPath: string,
  deps: ArchiveReaderDeps = defaultDeps
): Promise<ReadArchivedTranscriptResult> {
  const contained = resolveContainedPath(archiveRoot, jsonlPath)
  if (contained === null) {
    throw new ArchiveTranscriptReadError(
      `refusing to read transcript outside the archive root: ${jsonlPath}`
    )
  }

  let realRoot: string
  try {
    realRoot = await deps.realpath(archiveRoot)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new ArchiveTranscriptReadError(`failed to resolve archive root: ${detail}`)
  }

  let realTarget: string
  try {
    realTarget = await deps.realpath(contained)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new ArchiveTranscriptReadError(`failed to read archived transcript: ${detail}`)
  }

  if (resolveContainedPath(realRoot, realTarget) === null) {
    throw new ArchiveTranscriptReadError(
      `refusing to read transcript outside the archive root (resolved via symlink): ${jsonlPath}`
    )
  }

  let raw: string
  try {
    raw = await deps.readFile(realTarget)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new ArchiveTranscriptReadError(`failed to read archived transcript: ${detail}`)
  }

  const allTurns: JsonlDisplayTurn[] = []
  for (const line of raw.split('\n')) {
    const turn = parseJsonlLineForDisplay(line)
    if (turn) allTurns.push(turn)
  }

  const truncated = allTurns.length > MAX_DISPLAY_TURNS
  const turns = truncated ? allTurns.slice(allTurns.length - MAX_DISPLAY_TURNS) : allTurns
  const omittedCount = truncated ? allTurns.length - MAX_DISPLAY_TURNS : 0
  return { turns, truncated, omittedCount }
}
