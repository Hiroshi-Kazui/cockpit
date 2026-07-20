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
    // M7 followup (i18n): this reason string is a user-visible archive_mirror.last_error (surfaced
    // verbatim in ArchiveOutputSettings.tsx's per-session error list) -- Japanese, not English, to match
    // the rest of the UI. Also reached (deliberately) when `syncedBytes` is the
    // UNRECOVERABLE_SYNCED_BYTES sentinel below -- mirrorCoordinator.ts's runOnce/syncTranscript never
    // actually lets that case reach here anymore (it short-circuits sentinel rows before calling this), so
    // in practice this branch now only fires for a genuine DB-drift/spool-truncation bug, not the sentinel.
    return {
      action: 'error',
      reason:
        `記録済みのミラー進捗（${syncedBytes} バイト）がスプールのコピーサイズ（${spoolSize} バイト）を` +
        '超えています。処理を中止します'
    }
  }
  if (syncedBytes === spoolSize) return { action: 'noop' }
  return { action: 'append', offset: syncedBytes, length: spoolSize - syncedBytes }
}

/**
 * Sentinel `archive_mirror.synced_bytes` value recorded for a (session, dest_root) row whose destination
 * content cannot be safely trusted as a resume point (mirrorCoordinator.ts's rebaselineSession content-
 * prefix verification failed, or could not be completed) -- ADR-0009 decision 4's "恒久エラー". Centralized
 * here (followups minor "sentinel 定数の一元化") rather than left as a magic literal at each call site, so
 * every consumer (mirrorCoordinator.ts's runOnce/rebaselineSession, computeBackfillPlan's callers) checks it
 * the same way via `isUnrecoverableSyncedBytes` below instead of re-deriving the comparison. Deliberately
 * far larger than any real transcript could ever grow to, so computeTranscriptMirrorDiff's existing
 * "recorded progress exceeds spool size" guard would also (redundantly, defense-in-depth) refuse a sync
 * attempt that somehow reached it without going through the sentinel-aware short-circuit.
 */
export const UNRECOVERABLE_SYNCED_BYTES = Number.MAX_SAFE_INTEGER

/** Type guard / named comparison for the sentinel above -- see its doc comment for why this indirection
 * exists (single point of truth for "is this row permanently blocked", not a `=== Number.MAX_SAFE_INTEGER`
 * repeated at each call site). */
export function isUnrecoverableSyncedBytes(syncedBytes: number): boolean {
  return syncedBytes === UNRECOVERABLE_SYNCED_BYTES
}

export type ResumeVerificationRange =
  { ok: true; offset: number; length: number } | { ok: false; reason: string }

/**
 * ADR-0009 decision 3: before an already-tracked (session, dest_root) row resumes automatic mirroring
 * (mirrorCoordinator.ts's rebaselineSession, reached whenever setOutputRoot switches back to a root this
 * session was previously mirrored to), the destination's actual current physical size must be reconciled
 * against the *logical* spool offset recorded for it (`recordedSyncedBytes`). Per ADR-0008/D-4's
 * skip-history baseline, `recordedSyncedBytes` is frequently *ahead* of the destination's real physical
 * size by a permanent gap established the first time this root was ever configured for this session --
 * only the destination's trailing `destSize` bytes were ever actually written there. This computes which
 * spool byte range those `destSize` physical bytes are supposed to correspond to
 * (`[recordedSyncedBytes - destSize, recordedSyncedBytes)`), for the caller to read back and
 * byte-for-byte compare against the destination's actual content -- catching the destination having been
 * modified out-of-band (a different sync client, manual edit, etc.) while mirroring was pointed elsewhere.
 * `destSize` exceeding what was ever logically recorded is itself impossible under normal operation (this
 * app never grows a destination file beyond what it itself appended) and is treated as a confirmed
 * inconsistency, not merely "unverified" -- refused without attempting a read.
 *
 * M8/D-1 (M7 followup "destSize=0 エッジ"): `destSize === 0` while `recordedSyncedBytes > 0` is *also*
 * refused outright, rather than optimistically treated as a valid (if trivial, zero-length) range. From
 * these two numbers alone this is indistinguishable from the destination having genuinely held a
 * post-skip suffix that was then deleted out-of-band while mirroring was pointed elsewhere -- silently
 * resuming an ordinary sync from `recordedSyncedBytes` here would (re)create the destination file missing
 * its entire logical prefix, an append-only violation nothing downstream could ever detect from the file
 * alone. The one case this must NOT misfire on -- `destSize === 0` *and* `recordedSyncedBytes === 0`, a
 * brand-new output root just configured for a session with no destination content and nothing recorded
 * yet -- falls through unaffected to the ordinary trivial-range return below (offset=0, length=0).
 */
export function computeResumeVerificationRange({
  destSize,
  recordedSyncedBytes
}: {
  destSize: number
  recordedSyncedBytes: number
}): ResumeVerificationRange {
  if (destSize > recordedSyncedBytes) {
    return {
      ok: false,
      reason:
        `宛先の実サイズ（${destSize} バイト）が記録済みの進捗（${recordedSyncedBytes} バイト）を超えて` +
        'います。宛先が外部で変更された可能性があるため、自動同期を中止しました'
    }
  }
  if (destSize === 0 && recordedSyncedBytes > 0) {
    return {
      ok: false,
      reason:
        `宛先にミラー先ファイルが見つかりません（記録済みの進捗は ${recordedSyncedBytes} バイトです）。` +
        '宛先が外部で削除された可能性があるため、自動同期を中止しました。バックフィルを実行して復旧して' +
        'ください'
    }
  }
  return { ok: true, offset: recordedSyncedBytes - destSize, length: destSize }
}

export type BackfillPlan =
  { action: 'proceed'; rebaselineSyncedBytes: number } | { action: 'refuse'; reason: string }

/**
 * ADR-0008/D-4 "自動実行しない": decides whether an explicit backfill (mirrorCoordinator.ts's
 * startBackfill) may safely replicate a session's full history to the currently-configured root, extracted
 * as a pure function (followups structure #3 -- was inlined in startBackfill, now independently
 * unit-testable). A destination that already holds real bytes *ahead* of what full-history replication
 * would produce at this point (a post-skip *suffix* left over from an earlier ordinary sync that started
 * from a skip-rebaselined offset, not from spool byte 0) cannot be backfilled without corrupting it --
 * rebasing `synced_bytes` down to the destination's real size and resuming an ordinary sync would read the
 * *wrong* spool range and duplicate/interleave content. Refused outright rather than silently attempting it
 * (append-only violation must never be papered over, spec §4.4). Otherwise, `synced_bytes` is rebaselined
 * down to the destination's real current size so the ordinary sync pass that follows copies everything
 * from there (or the entire spool from scratch, for a still-empty destination).
 */
export function computeBackfillPlan({
  destSize,
  recordedSyncedBytes
}: {
  destSize: number
  recordedSyncedBytes: number
}): BackfillPlan {
  if (destSize > 0 && recordedSyncedBytes > destSize) {
    return {
      action: 'refuse',
      reason:
        `バックフィルできません: 宛先には既に ${destSize} バイトのデータがありますが、スプールの完全な` +
        '先頭一致ではありません（この出力先に対しては以前に履歴がスキップされています）。バックフィルを' +
        '行うと既存のミラー内容を破壊するおそれがあるため中止しました'
    }
  }
  return { action: 'proceed', rebaselineSyncedBytes: destSize }
}
