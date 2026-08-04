// Pins the same security-critical invariant as titleGenerator.test.ts (TD-5): the evaluation prompt
// (which embeds user-authored purpose text and transcript excerpts) must never appear in argv -- only
// ever written to the child's stdin. Uses an injected fake execFile so no real claude process is spawned.
import { describe, expect, it } from 'vitest'
import { runEvaluation, type EvaluationRunnerExecFile } from './evaluationRunner'
import type { ClaudeResolution } from '../pty/resolveClaude'

interface ExecFileCall {
  command: string
  args: string[]
}

function makeFakeExecFile(options: { stdout?: string; error?: Error | null; hasStdin?: boolean }): {
  execFile: EvaluationRunnerExecFile
  calls: ExecFileCall[]
  writtenToStdin: () => string | null
} {
  const calls: ExecFileCall[] = []
  let written: string | null = null

  const execFile: EvaluationRunnerExecFile = (command, args, _opts, callback) => {
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
      } as unknown as NonNullable<ReturnType<EvaluationRunnerExecFile>['stdin']>
    }
  }

  return { execFile, calls, writtenToStdin: () => written }
}

const exeResolution: ClaudeResolution = { path: 'C:\\tools\\claude.exe', kind: 'exe' }
const cmdResolution: ClaudeResolution = { path: 'C:\\npm\\claude.cmd', kind: 'cmd' }

describe('runEvaluation argv/stdin security invariant', () => {
  it('never places the prompt (purpose text / transcript excerpts) into argv, only static flags', async () => {
    const maliciousPrompt = '"& calc.exe \n目的: rm -rf /; $(whoami)'
    const { execFile, calls } = makeFakeExecFile({
      stdout: '{"smoothness":80,"stress":10,"commCost":10,"summary":"ok","suggestions":[]}'
    })

    await runEvaluation(maliciousPrompt, null, 'haiku', { resolution: exeResolution, execFile })

    expect(calls).toEqual([{ command: 'C:\\tools\\claude.exe', args: ['-p', '--model', 'haiku'] }])
    for (const arg of calls[0].args) {
      expect(arg).not.toContain(maliciousPrompt)
      expect(arg).not.toMatch(/calc\.exe|rm -rf|whoami/)
    }
  })

  it('passes the configured model as a static --model flag', async () => {
    const { execFile, calls } = makeFakeExecFile({ stdout: '{}' })
    await runEvaluation('prompt', null, 'sonnet', { resolution: exeResolution, execFile })
    expect(calls[0].args).toEqual(['-p', '--model', 'sonnet'])
  })

  it('still keeps argv free of the prompt when wrapped through cmd.exe /c for a .cmd shim', async () => {
    const maliciousPrompt = 'foo & del /f /q C:\\'
    const { execFile, calls } = makeFakeExecFile({ stdout: '{}' })

    await runEvaluation(maliciousPrompt, null, 'haiku', { resolution: cmdResolution, execFile })

    expect(calls).toEqual([
      { command: 'cmd.exe', args: ['/c', 'C:\\npm\\claude.cmd', '-p', '--model', 'haiku'] }
    ])
    for (const arg of calls[0].args) {
      expect(arg).not.toContain(maliciousPrompt)
    }
  })

  it('writes the prompt to the child stdin, not argv', async () => {
    const prompt = '目的の評価プロンプト本文'
    const { execFile, writtenToStdin } = makeFakeExecFile({ stdout: '{}' })

    await runEvaluation(prompt, null, 'haiku', { resolution: exeResolution, execFile })

    expect(writtenToStdin()).toBe(prompt)
  })
})

describe('runEvaluation failure handling', () => {
  it('rejects when the child exits with an error', async () => {
    const { execFile } = makeFakeExecFile({ error: new Error('claude exited 1') })
    await expect(
      runEvaluation('p', null, 'haiku', { resolution: exeResolution, execFile })
    ).rejects.toThrow('claude exited 1')
  })

  it('rejects when the child process has no writable stdin', async () => {
    const { execFile } = makeFakeExecFile({ hasStdin: false })
    await expect(
      runEvaluation('p', null, 'haiku', { resolution: exeResolution, execFile })
    ).rejects.toThrow(/no writable stdin/)
  })

  it('resolves with the raw stdout even when it is empty (parsing is the caller’s responsibility)', async () => {
    const { execFile } = makeFakeExecFile({ stdout: '' })
    const result = await runEvaluation('p', null, 'haiku', { resolution: exeResolution, execFile })
    expect(result).toBe('')
  })

  it('rejects via the stdin error path instead of throwing unhandled when the pipe errors (EPIPE)', async () => {
    const stdinErrorListeners: Array<(err: Error) => void> = []
    const execFile: EvaluationRunnerExecFile = () => ({
      stdin: {
        end: () => {
          queueMicrotask(() => {
            for (const listener of stdinErrorListeners) listener(new Error('EPIPE'))
          })
        },
        on: (_event: string, listener: (err: Error) => void) => {
          stdinErrorListeners.push(listener)
        }
      } as unknown as NonNullable<ReturnType<EvaluationRunnerExecFile>['stdin']>
    })

    await expect(
      runEvaluation('p', null, 'haiku', { resolution: exeResolution, execFile })
    ).rejects.toThrow('EPIPE')
  })
})
