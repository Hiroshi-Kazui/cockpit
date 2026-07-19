// Pins the security-critical invariant documented in titleGenerator.ts's header comment: the
// user-authored purpose text must never appear in argv (command-injection risk via cmd.exe's own
// metacharacter parsing, TD-5) -- it is only ever written to the child's stdin. Uses an injected fake
// `execFile` so no real claude process is spawned.
import { describe, expect, it } from 'vitest'
import { generateTitle, type TitleGeneratorExecFile } from './titleGenerator'
import type { ClaudeResolution } from './resolveClaude'

interface ExecFileCall {
  command: string
  args: string[]
}

/** Builds a fake execFile that immediately (via microtask, matching real async child_process timing)
 * invokes the completion callback with the given stdout/error, and records every call + whatever was
 * written to the fake child's stdin. */
function makeFakeExecFile(options: { stdout?: string; error?: Error | null; hasStdin?: boolean }): {
  execFile: TitleGeneratorExecFile
  calls: ExecFileCall[]
  writtenToStdin: () => string | null
} {
  const calls: ExecFileCall[] = []
  let written: string | null = null

  const execFile: TitleGeneratorExecFile = (command, args, _opts, callback) => {
    calls.push({ command, args: [...args] })
    queueMicrotask(() => callback(options.error ?? null, options.stdout ?? '', ''))
    if (options.hasStdin === false) {
      return { stdin: null }
    }
    return {
      stdin: {
        end: (data: string) => {
          written = data
        },
        on: () => undefined
      } as unknown as NonNullable<ReturnType<TitleGeneratorExecFile>['stdin']>
    }
  }

  return { execFile, calls, writtenToStdin: () => written }
}

const exeResolution: ClaudeResolution = { path: 'C:\\tools\\claude.exe', kind: 'exe' }
const cmdResolution: ClaudeResolution = { path: 'C:\\npm\\claude.cmd', kind: 'cmd' }

describe('generateTitle argv/stdin security invariant', () => {
  it('never places purpose text into argv, only the static -p/--model/haiku flags', async () => {
    const maliciousPurpose = '"& calc.exe \n; rm -rf /; $(whoami)'
    const { execFile, calls } = makeFakeExecFile({ stdout: 'サンプルタイトル' })

    const title = await generateTitle(maliciousPurpose, null, {
      resolution: exeResolution,
      execFile
    })

    expect(title).toBe('サンプルタイトル')
    expect(calls).toEqual([{ command: 'C:\\tools\\claude.exe', args: ['-p', '--model', 'haiku'] }])
    for (const arg of calls[0].args) {
      expect(arg).not.toContain(maliciousPurpose)
      expect(arg).not.toMatch(/calc\.exe|rm -rf|whoami/)
    }
  })

  it('still keeps argv free of the purpose text when wrapped through cmd.exe /c for a .cmd shim', async () => {
    const maliciousPurpose = 'foo & del /f /q C:\\'
    const { execFile, calls } = makeFakeExecFile({ stdout: 'title' })

    await generateTitle(maliciousPurpose, null, { resolution: cmdResolution, execFile })

    expect(calls).toEqual([
      { command: 'cmd.exe', args: ['/c', 'C:\\npm\\claude.cmd', '-p', '--model', 'haiku'] }
    ])
    for (const arg of calls[0].args) {
      expect(arg).not.toContain(maliciousPurpose)
    }
  })

  it('writes the purpose-derived prompt to the child stdin, not argv', async () => {
    const purpose = 'READMEにセットアップ手順を追記して'
    const { execFile, writtenToStdin } = makeFakeExecFile({ stdout: 'title' })

    await generateTitle(purpose, null, { resolution: exeResolution, execFile })

    expect(writtenToStdin()).toContain(purpose)
  })
})

describe('generateTitle failure handling', () => {
  it('rejects when the child exits with an error', async () => {
    const { execFile } = makeFakeExecFile({ error: new Error('claude exited 1') })

    await expect(
      generateTitle('fix the bug', null, { resolution: exeResolution, execFile })
    ).rejects.toThrow('claude exited 1')
  })

  it('rejects when the child produces no usable output (empty/whitespace-only stdout)', async () => {
    const { execFile } = makeFakeExecFile({ stdout: '   \n  ' })

    await expect(
      generateTitle('fix the bug', null, { resolution: exeResolution, execFile })
    ).rejects.toThrow(/no usable title output/)
  })

  it('rejects when the child process has no writable stdin', async () => {
    const { execFile } = makeFakeExecFile({ hasStdin: false })

    await expect(
      generateTitle('fix the bug', null, { resolution: exeResolution, execFile })
    ).rejects.toThrow(/no writable stdin/)
  })

  it('rejects via the stdin error path instead of throwing unhandled when the pipe errors (EPIPE)', async () => {
    const stdinErrorListeners: Array<(err: Error) => void> = []
    const execFile: TitleGeneratorExecFile = () => ({
      stdin: {
        end: () => {
          // Simulate the real-world race: the child already exited before consuming stdin, so writing
          // to the closed pipe emits an async 'error' instead of the execFile callback ever firing.
          queueMicrotask(() => {
            for (const listener of stdinErrorListeners) listener(new Error('EPIPE'))
          })
        },
        on: (_event: string, listener: (err: Error) => void) => {
          stdinErrorListeners.push(listener)
        }
      } as unknown as NonNullable<ReturnType<TitleGeneratorExecFile>['stdin']>
    })

    await expect(
      generateTitle('fix the bug', null, { resolution: exeResolution, execFile })
    ).rejects.toThrow('EPIPE')
  })
})
