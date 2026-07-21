// Unit tests for the pure classification/spawn-command logic of TD-5 (no PATH lookups; those are side-effecting).
import { describe, expect, it } from 'vitest'
import {
  buildSpawnCommand,
  classifyClaudePath,
  ClaudeResolutionError,
  selectClaudeCandidate
} from './resolveClaude'

describe('classifyClaudePath', () => {
  it('classifies .exe as exe (direct spawn)', () => {
    expect(classifyClaudePath('C:\\tools\\claude.exe')).toBe('exe')
  })

  it('classifies .cmd as cmd (npm shim, needs cmd.exe wrapper)', () => {
    expect(classifyClaudePath('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')).toBe('cmd')
  })

  it('classifies .bat as cmd', () => {
    expect(classifyClaudePath('C:\\tools\\claude.bat')).toBe('cmd')
  })

  it('is case-insensitive on extension', () => {
    expect(classifyClaudePath('C:\\tools\\CLAUDE.EXE')).toBe('exe')
  })

  it('throws ClaudeResolutionError for unsupported extensions', () => {
    expect(() => classifyClaudePath('C:\\tools\\claude.sh')).toThrow(ClaudeResolutionError)
  })
})

describe('selectClaudeCandidate', () => {
  it("prefers the .cmd shim over npm's extensionless launcher (the reported bug)", () => {
    // `where claude` lists the extensionless POSIX launcher first, then the .cmd shim.
    const lines = [
      'C:\\Users\\me\\AppData\\Roaming\\npm\\claude',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'
    ]
    expect(selectClaudeCandidate(lines)).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')
  })

  it('prefers .exe over .cmd when both are present', () => {
    const lines = ['C:\\npm\\claude.cmd', 'C:\\tools\\claude.exe']
    expect(selectClaudeCandidate(lines)).toBe('C:\\tools\\claude.exe')
  })

  it('accepts a .bat shim when no .exe/.cmd exists', () => {
    expect(selectClaudeCandidate(['C:\\tools\\claude', 'C:\\tools\\claude.bat'])).toBe(
      'C:\\tools\\claude.bat'
    )
  })

  it('trims whitespace and ignores blank lines', () => {
    expect(selectClaudeCandidate(['', '  C:\\tools\\claude.exe  ', ''])).toBe(
      'C:\\tools\\claude.exe'
    )
  })

  it('falls back to the first line when nothing has a supported extension', () => {
    // Downstream disk probing / a precise error handles this case.
    expect(selectClaudeCandidate(['C:\\npm\\claude'])).toBe('C:\\npm\\claude')
  })

  it('returns null for an empty result', () => {
    expect(selectClaudeCandidate([])).toBeNull()
    expect(selectClaudeCandidate(['', '   '])).toBeNull()
  })
})

describe('buildSpawnCommand', () => {
  it('spawns .exe directly with the given args', () => {
    const result = buildSpawnCommand({ path: 'C:\\tools\\claude.exe', kind: 'exe' }, [
      '--settings',
      'x.json'
    ])
    expect(result).toEqual({ command: 'C:\\tools\\claude.exe', args: ['--settings', 'x.json'] })
  })

  it('wraps .cmd shims through cmd.exe /c', () => {
    const result = buildSpawnCommand({ path: 'C:\\npm\\claude.cmd', kind: 'cmd' }, [
      '--settings',
      'x.json'
    ])
    expect(result).toEqual({
      command: 'cmd.exe',
      args: ['/c', 'C:\\npm\\claude.cmd', '--settings', 'x.json']
    })
  })

  it('passes through an empty args list', () => {
    expect(buildSpawnCommand({ path: 'C:\\tools\\claude.exe', kind: 'exe' }, [])).toEqual({
      command: 'C:\\tools\\claude.exe',
      args: []
    })
  })
})
