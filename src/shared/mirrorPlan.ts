// Pure functions backing the M6 archive-output mirror (spec §4.4.1, ADR-0008): output-root validity
// judgement (self-mirror prevention, D-5) and the transcript append-diff calculation the mirror engine
// uses to decide what to copy next (D-2/D-6). No fs/DB access here -- both are exercised with plain
// strings/numbers so they are unit-testable without touching disk or Electron, and so the mirror engine
// (main/archive/mirror/mirrorCoordinator.ts) can stay a thin orchestrator around these decisions.
import path from 'node:path'

export type MirrorRootValidation = { ok: true } | { ok: false; reason: string }

/**
 * Judges whether `candidateRoot` is a valid archive-output (mirror) destination relative to the
 * spool root (`userData/archive`, D-1/D-6). Rejects an empty path and, per D-5's self-mirror
 * prevention, rejects the spool root itself or any path underneath it (mirroring the spool into
 * itself would violate append-only by definition -- the mirror engine would be reading and writing the
 * same tree). Does not touch the filesystem; whether the path is actually writable is a separate,
 * effectful probe (main/archive/mirror/fsSink.ts's `probeWritable`).
 */
export function validateMirrorRoot(spoolRoot: string, candidateRoot: string): MirrorRootValidation {
  const trimmed = candidateRoot.trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: '出力先フォルダを指定してください' }
  }
  const resolvedSpool = path.resolve(spoolRoot)
  const resolvedCandidate = path.resolve(trimmed)
  const relative = path.relative(resolvedSpool, resolvedCandidate)
  const isSpoolOrDescendant =
    relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  if (isSpoolOrDescendant) {
    return {
      ok: false,
      reason: 'アーカイブの出力先にスプール自身またはその配下のフォルダは指定できません'
    }
  }
  return { ok: true }
}

export type MirrorDiffResult =
  | { action: 'append'; offset: number; length: number }
  | { action: 'noop' }
  | { action: 'error'; reason: string }

/**
 * Given the spool transcript's current size and how many bytes of it have already been mirrored to the
 * configured output root (`archive_mirror.synced_bytes`, D-6), decides what the mirror engine should do
 * next: append the not-yet-mirrored tail, do nothing (already caught up), or flag an error.
 *
 * `syncedBytes > spoolSize` should never happen in normal operation (the spool is append-only, so it can
 * only grow) -- it signals either DB drift or a spool that was somehow truncated, and is surfaced as an
 * error rather than silently clamped (append-only violation must never be papered over, spec §4.4).
 */
export function computeTranscriptMirrorDiff({
  spoolSize,
  syncedBytes
}: {
  spoolSize: number
  syncedBytes: number
}): MirrorDiffResult {
  if (syncedBytes > spoolSize) {
    return {
      action: 'error',
      reason: `recorded mirror progress (${syncedBytes} bytes) exceeds the spool copy's size (${spoolSize} bytes); refusing to proceed`
    }
  }
  if (syncedBytes === spoolSize) return { action: 'noop' }
  return { action: 'append', offset: syncedBytes, length: spoolSize - syncedBytes }
}
