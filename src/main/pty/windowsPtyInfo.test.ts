import { describe, expect, it } from 'vitest'
import { describeWindowsPty, parseWindowsBuildNumber } from './windowsPtyInfo'

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

describe('describeWindowsPty', () => {
  it('reports conpty for builds node-pty would spawn under ConPTY', () => {
    expect(describeWindowsPty('win32', '10.0.26200')).toEqual({
      backend: 'conpty',
      buildNumber: 26200
    })
    // node-pty's threshold itself (>= 18309).
    expect(describeWindowsPty('win32', '10.0.18309')).toEqual({
      backend: 'conpty',
      buildNumber: 18309
    })
  })

  it('reports winpty below node-pty’s ConPTY threshold', () => {
    expect(describeWindowsPty('win32', '10.0.18308')).toEqual({
      backend: 'winpty',
      buildNumber: 18308
    })
  })

  it('reports null on non-Windows hosts', () => {
    expect(describeWindowsPty('darwin', '23.5.0')).toBeNull()
    expect(describeWindowsPty('linux', '6.5.0')).toBeNull()
  })

  it('reports null rather than guessing when the build number is unreadable', () => {
    expect(describeWindowsPty('win32', 'unknown')).toBeNull()
  })
})
