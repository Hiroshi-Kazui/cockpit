// Headless one-shot evaluation execution (ADR-0010 D-2: `claude -p --model <model>`, same shape as
// main/pty/titleGenerator.ts's generateTitle). Runs as a fully separate, non-interactive child process --
// never writes to a pane's pty -- so an evaluation run can never interfere with a live claude session
// (D-1/D-2 "会話用ptyとは完全に別プロセス").
//
// SECURITY (TD-5, same invariant as titleGenerator.ts): the prompt embeds user-authored purpose text and
// archived transcript excerpts, and must never be interpolated into a shell command line -- on Windows, a
// `.cmd` npm shim is invoked via `cmd.exe /c <path> <args>`, and cmd.exe performs its own metacharacter
// parsing even without a shell wrapper. This module passes the prompt over the child's stdin only, so
// argv never carries anything but the static `-p`/`--model`/<model> flags. Pinned by
// evaluationRunner.test.ts the same way titleGenerator.test.ts pins generateTitle.
import { execFile as nodeExecFile, type ChildProcess } from 'node:child_process'
import { buildSpawnCommand, resolveClaude, type ClaudeResolution } from '../pty/resolveClaude'

export type EvaluationRunnerExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean },
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => Pick<ChildProcess, 'stdin'>

const defaultExecFile: EvaluationRunnerExecFile = (file, args, options, callback) =>
  nodeExecFile(file, args, options, callback)

export interface RunEvaluationDeps {
  resolution?: ClaudeResolution
  timeoutMs?: number
  execFile?: EvaluationRunnerExecFile
}

/** Evaluation prompts (transcript excerpts, D-8) are larger than a title prompt and the model has more to
 * reason about (3 scores + summary + suggestions), so this is deliberately longer than titleGenerator's
 * 15s default. */
const DEFAULT_EVALUATION_TIMEOUT_MS = 60_000

/**
 * Runs `claude -p --model <model>` headlessly with `prompt` (via stdin) and resolves to the raw stdout,
 * unparsed -- shared/evaluation.ts's parseEvaluationResult is the caller's (evaluationCoordinator.ts's)
 * responsibility, kept separate so the tolerant-parsing logic stays pure/unit-testable independent of any
 * process I/O. Rejects on resolution failure, spawn/exit failure -- callers must catch this and record it
 * as the evaluation's `last_error` (R-7), never silently default to a 0-point result.
 */
export async function runEvaluation(
  prompt: string,
  claudePathOverride: string | null,
  model: string,
  deps: RunEvaluationDeps = {}
): Promise<string> {
  const resolution = deps.resolution ?? resolveClaude(claudePathOverride)
  const { command, args } = buildSpawnCommand(resolution, ['-p', '--model', model])
  const timeoutMs = deps.timeoutMs ?? DEFAULT_EVALUATION_TIMEOUT_MS
  const runExecFile = deps.execFile ?? defaultExecFile

  return await new Promise<string>((resolve, reject) => {
    let settled = false
    const settleResolve = (stdout: string): void => {
      if (settled) return
      settled = true
      resolve(stdout)
    }
    const settleReject = (err: Error): void => {
      if (settled) return
      settled = true
      reject(err)
    }

    const child = runExecFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) {
          settleReject(err)
          return
        }
        settleResolve(stdout)
      }
    )
    if (!child.stdin) {
      settleReject(new Error('claude -p child process has no writable stdin'))
      return
    }
    // Defense-in-depth (same rationale as titleGenerator.ts): a write to an already-closed stdin pipe
    // emits an async EPIPE 'error' event rather than ever invoking the execFile callback -- without a
    // listener, Node treats that as an unhandled/fatal exception.
    child.stdin.on('error', (stdinErr: Error) => {
      settleReject(stdinErr)
    })
    child.stdin.end(prompt)
  })
}
