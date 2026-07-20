import { describe, expect, it } from 'vitest'
import { computeTranscriptMirrorDiff, validateMirrorRoot } from './mirrorPlan'

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

  it('returns error when recorded progress exceeds the spool size (append-only violation guard)', () => {
    const result = computeTranscriptMirrorDiff({ spoolSize: 10, syncedBytes: 20 })
    expect(result.action).toBe('error')
    if (result.action === 'error') {
      expect(result.reason).toMatch(/exceeds the spool copy/)
    }
  })

  it('treats an empty spool with zero recorded progress as noop', () => {
    expect(computeTranscriptMirrorDiff({ spoolSize: 0, syncedBytes: 0 })).toEqual({
      action: 'noop'
    })
  })
})
