import { describe, expect, it } from 'vitest'
import { describeWindowsPty, parseWindowsBuildNumber, resolveUseConptyDll } from './windowsPtyInfo'

describe('parseWindowsBuildNumber', () => {
  it('reads the build number out of an os.release() string', () => {
    expect(parseWindowsBuildNumber('10.0.26200')).toBe(26200)
    expect(parseWindowsBuildNumber('10.0.19045')).toBe(19045)
  })

  it('returns 0 for a release string with no build number', () => {
    expect(parseWindowsBuildNumber('')).toBe(0)
    expect(parseWindowsBuildNumber('6.5.0-linux')).toBe(0)
  })
})

// M12 (ADR-0014 D-2): the env var escape hatch back to the OS conhost-hosted ConPTY. This is the single
// place the flag's parsing rule lives -- ptyManager.spawn()'s useConptyDll choice and describeHostWindowsPty
// (below) both call this function rather than re-parsing the env var themselves (ADR-0014 D-3).
describe('resolveUseConptyDll', () => {
  it('defaults to true (uses the bundled conpty.dll) when the env var is unset', () => {
    expect(resolveUseConptyDll({})).toBe(true)
  })

  it('is disabled only by the exact value "1"', () => {
    expect(resolveUseConptyDll({ COCKPIT_DISABLE_CONPTY_DLL: '1' })).toBe(false)
  })

  it('stays enabled for any other value, including an empty string or a typo -- a malformed override must not silently fall back to the old backend', () => {
    expect(resolveUseConptyDll({ COCKPIT_DISABLE_CONPTY_DLL: '' })).toBe(true)
    expect(resolveUseConptyDll({ COCKPIT_DISABLE_CONPTY_DLL: 'true' })).toBe(true)
    expect(resolveUseConptyDll({ COCKPIT_DISABLE_CONPTY_DLL: '0' })).toBe(true)
  })
})

describe('describeWindowsPty', () => {
  it('reports conpty for builds node-pty would spawn under ConPTY', () => {
    expect(describeWindowsPty('win32', '10.0.26200', true)).toEqual({
      backend: 'conpty',
      buildNumber: 26200
    })
    // node-pty's threshold itself (>= 18309).
    expect(describeWindowsPty('win32', '10.0.18309', true)).toEqual({
      backend: 'conpty',
      buildNumber: 18309
    })
  })

  it('reports winpty below node-pty’s ConPTY threshold', () => {
    expect(describeWindowsPty('win32', '10.0.18308', true)).toEqual({
      backend: 'winpty',
      buildNumber: 18308
    })
  })

  it('reports null on non-Windows hosts', () => {
    expect(describeWindowsPty('darwin', '23.5.0', true)).toBeNull()
    expect(describeWindowsPty('linux', '6.5.0', true)).toBeNull()
  })

  it('reports null rather than guessing when the build number is unreadable', () => {
    expect(describeWindowsPty('win32', 'unknown', true)).toBeNull()
  })

  // M12 (ADR-0014 D-3, R-2): useConptyDll only selects *which* conpty.dll node-pty loads once ConPTY is
  // already the chosen backend -- confirmed against node-pty 1.1.0's own windowsPtyAgent.js, whose backend/
  // build-number selection (L37-38, L50) never reads `_useConptyDll` at all. It can therefore never flip
  // conpty/winpty or the build number this function reports, above or below the threshold. (See
  // windowsPtyInfo.ts's describeWindowsPty doc comment for where `_useConptyDll` *is* read elsewhere in
  // node-pty, none of which this function's return value depends on.)
  it('reports the identical descriptor regardless of useConptyDll, both above and below the ConPTY threshold', () => {
    expect(describeWindowsPty('win32', '10.0.26200', true)).toEqual({
      backend: 'conpty',
      buildNumber: 26200
    })
    expect(describeWindowsPty('win32', '10.0.26200', false)).toEqual({
      backend: 'conpty',
      buildNumber: 26200
    })
    expect(describeWindowsPty('win32', '10.0.18308', true)).toEqual({
      backend: 'winpty',
      buildNumber: 18308
    })
    expect(describeWindowsPty('win32', '10.0.18308', false)).toEqual({
      backend: 'winpty',
      buildNumber: 18308
    })
  })
})
