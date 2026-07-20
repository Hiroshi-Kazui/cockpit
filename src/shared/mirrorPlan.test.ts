import { describe, expect, it } from 'vitest'
import {
  computeBackfillPlan,
  computeResumeVerificationRange,
  computeTranscriptMirrorDiff,
  isUnrecoverableSyncedBytes,
  UNRECOVERABLE_SYNCED_BYTES,
  validateMirrorRoot
} from './mirrorPlan'

describe('validateMirrorRoot (M6, ADR-0008/D-5 self-mirror prevention)', () => {
  const spoolRoot = 'C:\\Users\\me\\AppData\\Roaming\\cockpit\\archive'

  it('rejects an empty path', () => {
    expect(validateMirrorRoot(spoolRoot, '')).toEqual({
      ok: false,
      reason: '出力先フォルダを指定してください'
    })
    expect(validateMirrorRoot(spoolRoot, '   ')).toEqual({
      ok: false,
      reason: '出力先フォルダを指定してください'
    })
  })

  it('rejects the spool root itself', () => {
    const result = validateMirrorRoot(spoolRoot, spoolRoot)
    expect(result.ok).toBe(false)
  })

  it('rejects a subdirectory of the spool root', () => {
    const result = validateMirrorRoot(spoolRoot, `${spoolRoot}\\some-session-id`)
    expect(result.ok).toBe(false)
  })

  it('accepts an unrelated local path', () => {
    expect(validateMirrorRoot(spoolRoot, 'D:\\GoogleDrive\\cockpit-archive')).toEqual({ ok: true })
  })

  it('accepts a sibling directory under the same parent as the spool root', () => {
    expect(
      validateMirrorRoot(spoolRoot, 'C:\\Users\\me\\AppData\\Roaming\\cockpit\\archive-mirror')
    ).toEqual({ ok: true })
  })

  it('accepts an ancestor of the spool root (only spool-or-descendant is rejected, not ancestors)', () => {
    expect(validateMirrorRoot(spoolRoot, 'C:\\Users\\me\\AppData\\Roaming\\cockpit')).toEqual({
      ok: true
    })
  })
})

describe('computeTranscriptMirrorDiff (M6, ADR-0008/D-2/D-6)', () => {
  it('returns noop when fully caught up', () => {
    expect(computeTranscriptMirrorDiff({ spoolSize: 100, syncedBytes: 100 })).toEqual({
      action: 'noop'
    })
  })

  it('returns append with the not-yet-mirrored tail when behind', () => {
    expect(computeTranscriptMirrorDiff({ spoolSize: 150, syncedBytes: 100 })).toEqual({
      action: 'append',
      offset: 100,
      length: 50
    })
  })

  it('returns append covering the whole spool from a fresh (zero) baseline', () => {
    expect(computeTranscriptMirrorDiff({ spoolSize: 42, syncedBytes: 0 })).toEqual({
      action: 'append',
      offset: 0,
      length: 42
    })
  })

  it('returns error (in Japanese, i18n followup) when recorded progress exceeds the spool size (append-only violation guard)', () => {
    const result = computeTranscriptMirrorDiff({ spoolSize: 10, syncedBytes: 20 })
    expect(result.action).toBe('error')
    if (result.action === 'error') {
      expect(result.reason).toMatch(/スプール/)
      expect(result.reason).not.toMatch(/[a-zA-Z]{4,}/) // no stray English prose leaking into the UI
    }
  })

  it('treats an empty spool with zero recorded progress as noop', () => {
    expect(computeTranscriptMirrorDiff({ spoolSize: 0, syncedBytes: 0 })).toEqual({
      action: 'noop'
    })
  })
})

describe('UNRECOVERABLE_SYNCED_BYTES / isUnrecoverableSyncedBytes (ADR-0009 sentinel, followups minor)', () => {
  it('recognizes the sentinel value', () => {
    expect(isUnrecoverableSyncedBytes(UNRECOVERABLE_SYNCED_BYTES)).toBe(true)
  })

  it('does not mistake an ordinary large-but-real byte count for the sentinel', () => {
    expect(isUnrecoverableSyncedBytes(10_000_000_000)).toBe(false)
    expect(isUnrecoverableSyncedBytes(0)).toBe(false)
  })
})

describe('computeResumeVerificationRange (ADR-0009 decision 3: per-root resume content verification)', () => {
  it('computes the expected spool range for a destination with no skip-gap (gap=0, full mirror)', () => {
    expect(computeResumeVerificationRange({ destSize: 100, recordedSyncedBytes: 100 })).toEqual({
      ok: true,
      offset: 0,
      length: 100
    })
  })

  it('computes the expected spool range for a destination behind a permanent D-4 skip-gap', () => {
    // recordedSyncedBytes tracks the spool's logical offset (100 skipped + 50 actually copied = 150);
    // only the trailing 50 bytes were ever physically written to the destination.
    expect(computeResumeVerificationRange({ destSize: 50, recordedSyncedBytes: 150 })).toEqual({
      ok: true,
      offset: 100,
      length: 50
    })
  })

  it('treats a destination with nothing physically written yet as a trivial (zero-length) range', () => {
    expect(computeResumeVerificationRange({ destSize: 0, recordedSyncedBytes: 100 })).toEqual({
      ok: true,
      offset: 100,
      length: 0
    })
  })

  it('refuses when the destination holds more bytes than were ever logically recorded (impossible under normal operation)', () => {
    const result = computeResumeVerificationRange({ destSize: 200, recordedSyncedBytes: 100 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/宛先/)
    }
  })
})

describe('computeBackfillPlan (ADR-0008/D-4 explicit backfill, followups structure #3)', () => {
  it('proceeds (rebaselining synced_bytes to the destination size) when the destination is empty', () => {
    expect(computeBackfillPlan({ destSize: 0, recordedSyncedBytes: 100 })).toEqual({
      action: 'proceed',
      rebaselineSyncedBytes: 0
    })
  })

  it('proceeds when the destination already holds a value not ahead of the recorded progress (nothing to corrupt)', () => {
    expect(computeBackfillPlan({ destSize: 50, recordedSyncedBytes: 50 })).toEqual({
      action: 'proceed',
      rebaselineSyncedBytes: 50
    })
  })

  it('refuses when the destination holds post-skip-suffix content (recorded progress ahead of destination size)', () => {
    const result = computeBackfillPlan({ destSize: 50, recordedSyncedBytes: 150 })
    expect(result.action).toBe('refuse')
    if (result.action === 'refuse') {
      expect(result.reason).toMatch(/バックフィル/)
    }
  })
})
