// Pins ADR-0013/D-8 (non-interactive env + per-command timeout) and the never-throw Result-type contract
// (D-2/D-3). Uses an injected fake execFile (mirrors titleGenerator.test.ts's pattern) -- no real git
// process is ever spawned.
import { describe, expect, it } from 'vitest'
import { GIT_TIMEOUT_MS, runGit, type GitExecFile } from './gitCli'

interface ExecFileCall {
  file: string
  args: string[]
  options: { cwd: string; timeout: number; windowsHide: boolean; env: Record<string, string> }
}

function makeFakeExecFile(
  behavior: (call: ExecFileCall) => {
    error?: (Error & { code?: string; killed?: boolean }) | null
    stdout?: string
    stderr?: string
  }
): { execFile: GitExecFile; calls: ExecFileCall[] } {
  const calls: ExecFileCall[] = []
  const execFile: GitExecFile = (file, args, options, callback) => {
    const call: ExecFileCall = { file, args: [...args], options }
    calls.push(call)
    const result = behavior(call)
    queueMicrotask(() => callback(result.error ?? null, result.stdout ?? '', result.stderr ?? ''))
  }
  return { execFile, calls }
}

describe('runGit non-interactive env (D-8)', () => {
  it('sets GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never, and disables GIT_ASKPASS/SSH_ASKPASS', async () => {
    const { execFile, calls } = makeFakeExecFile(() => ({ stdout: 'ok' }))

    await runGit(['status'], 'C:\\repo', GIT_TIMEOUT_MS.query, execFile)

    const env = calls[0].options.env
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GCM_INTERACTIVE).toBe('never')
    expect(env.GIT_ASKPASS).toBeFalsy()
    expect(env.SSH_ASKPASS).toBeFalsy()
  })

  it('FIX M1 (review iter1): forces the C locale so git stderr text is always English (locale-independent stderr matching)', async () => {
    const { execFile, calls } = makeFakeExecFile(() => ({ stdout: 'ok' }))

    await runGit(['status'], 'C:\\repo', GIT_TIMEOUT_MS.query, execFile)

    const env = calls[0].options.env
    expect(env.LC_ALL).toBe('C')
    expect(env.LANG).toBe('C')
    expect(env.LANGUAGE).toBe('')
  })

  it('overrides an inherited GIT_ASKPASS from the parent process env rather than merely leaving it unset', async () => {
    const original = process.env.GIT_ASKPASS
    process.env.GIT_ASKPASS = '/some/inherited/askpass'
    try {
      const { execFile, calls } = makeFakeExecFile(() => ({ stdout: 'ok' }))
      await runGit(['status'], 'C:\\repo', GIT_TIMEOUT_MS.query, execFile)
      expect(calls[0].options.env.GIT_ASKPASS).toBe('')
    } finally {
      if (original === undefined) delete process.env.GIT_ASKPASS
      else process.env.GIT_ASKPASS = original
    }
  })

  it('passes the requested cwd and timeout through unchanged', async () => {
    const { execFile, calls } = makeFakeExecFile(() => ({ stdout: 'ok' }))

    await runGit(
      ['rev-parse', '--show-toplevel'],
      'C:\\repo\\sub',
      GIT_TIMEOUT_MS.checkout,
      execFile
    )

    expect(calls[0].options.cwd).toBe('C:\\repo\\sub')
    expect(calls[0].options.timeout).toBe(GIT_TIMEOUT_MS.checkout)
    expect(calls[0].args).toEqual(['rev-parse', '--show-toplevel'])
  })
})

describe('runGit result mapping (never throws, D-2)', () => {
  it('resolves ok:true with stdout on success', async () => {
    const { execFile } = makeFakeExecFile(() => ({ stdout: 'C:/repo\n' }))
    const result = await runGit(
      ['rev-parse', '--show-toplevel'],
      'C:\\repo',
      GIT_TIMEOUT_MS.query,
      execFile
    )
    expect(result).toEqual({ ok: true, stdout: 'C:/repo\n' })
  })

  it('maps an ENOENT spawn error to kind=enoent (git not installed)', async () => {
    const { execFile } = makeFakeExecFile(() => ({
      error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    }))
    const result = await runGit(['status'], 'C:\\repo', GIT_TIMEOUT_MS.query, execFile)
    expect(result).toEqual({ ok: false, kind: 'enoent', message: 'spawn git ENOENT' })
  })

  it('maps a timeout-killed process to kind=timeout without throwing', async () => {
    const { execFile } = makeFakeExecFile(() => ({
      error: Object.assign(new Error('killed'), { killed: true })
    }))
    const result = await runGit(['pull', '--ff-only'], 'C:\\repo', GIT_TIMEOUT_MS.pull, execFile)
    expect(result.ok).toBe(false)
    expect((result as { kind: string }).kind).toBe('timeout')
    expect((result as { message: string }).message).toContain('timed out')
  })

  it('maps a non-zero exit to kind=error carrying stderr', async () => {
    const { execFile } = makeFakeExecFile(() => ({
      error: new Error('Command failed'),
      stderr: 'fatal: not a git repository\n'
    }))
    const result = await runGit(['status'], 'C:\\repo', GIT_TIMEOUT_MS.query, execFile)
    expect(result).toEqual({
      ok: false,
      kind: 'error',
      message: 'fatal: not a git repository'
    })
  })

  it('falls back to the error message when stderr is empty', async () => {
    const { execFile } = makeFakeExecFile(() => ({
      error: new Error('Command failed with exit code 1')
    }))
    const result = await runGit(['status'], 'C:\\repo', GIT_TIMEOUT_MS.query, execFile)
    expect(result).toEqual({ ok: false, kind: 'error', message: 'Command failed with exit code 1' })
  })
})
