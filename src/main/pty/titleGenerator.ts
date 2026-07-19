// Headless one-shot title generation (spec §4.2: `claude -p --model haiku`). Runs as a fully separate,
// non-interactive child process -- never writes to a pane's pty -- so it can never block pane
// interaction (AC "タイトル生成はペイン操作をブロックしない"). Placed alongside resolveClaude.ts
// (rather than under telemetry/) since it reuses resolveClaude/buildSpawnCommand directly.
//
// SECURITY: the purpose text is user-authored and must never be interpolated into a shell command
// line -- on Windows, a `.cmd` npm shim is invoked via `cmd.exe /c <path> <args>` (TD-5), and cmd.exe
// performs its own metacharacter parsing (`&`, `|`, `"`, etc.) even when spawned without a shell
// wrapper, which would make embedding arbitrary user text as an argv element a command-injection risk.
// This module instead passes the prompt over the child's stdin (claude's `-p` reads the prompt from
// stdin when no positional query argument is given), so argv never carries anything but static flags.
// This invariant is pinned by titleGenerator.test.ts via the injectable `execFile` dep below.
import { execFile as nodeExecFile, type ChildProcess } from 'node:child_process'
import { buildSpawnCommand, resolveClaude, type ClaudeResolution } from './resolveClaude'
import { buildTitlePrompt, sanitizeGeneratedTitle } from '../../shared/title'

/** Narrow shape of node:child_process.execFile this module actually uses -- injectable so tests can
 * assert on the exact argv/stdin interaction without spawning a real process. */
export type TitleGeneratorExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean },
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => Pick<ChildProcess, 'stdin'>

const defaultExecFile: TitleGeneratorExecFile = (file, args, options, callback) =>
  nodeExecFile(file, args, options, callback)

export interface GenerateTitleDeps {
  /** Injectable for tests; defaults to resolving via resolveClaude(claudePathOverride). */
  resolution?: ClaudeResolution
  timeoutMs?: number
  /** Injectable for tests; defaults to node:child_process.execFile. */
  execFile?: TitleGeneratorExecFile
}

const DEFAULT_TITLE_TIMEOUT_MS = 15_000

/**
 * Runs `claude -p --model haiku` headlessly with the purpose text (via stdin) and resolves to a
 * sanitized, ~20-character title. Rejects on resolution failure, spawn/exit failure, or empty/unusable
 * output -- callers (purposeCoordinator) must catch this, log it, and apply the truncate-fallback
 * (spec §4.2 step 5); this function never applies the fallback itself.
 */
export async function generateTitle(
  purposeText: string,
  claudePathOverride: string | null,
  deps: GenerateTitleDeps = {}
): Promise<string> {
  const resolution = deps.resolution ?? resolveClaude(claudePathOverride)
  const { command, args } = buildSpawnCommand(resolution, ['-p', '--model', 'haiku'])
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TITLE_TIMEOUT_MS
  const prompt = buildTitlePrompt(purposeText)
  const runExecFile = deps.execFile ?? defaultExecFile

  return await new Promise<string>((resolve, reject) => {
    let settled = false
    const settleResolve = (title: string): void => {
      if (settled) return
      settled = true
      resolve(title)
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
        const title = sanitizeGeneratedTitle(stdout)
        if (title === null) {
          settleReject(new Error('claude -p produced no usable title output'))
          return
        }
        settleResolve(title)
      }
    )
    if (!child.stdin) {
      settleReject(new Error('claude -p child process has no writable stdin'))
      return
    }
    // Defense-in-depth: if claude exits immediately (e.g. it never gets around to reading stdin), a
    // write to the now-closed pipe emits an EPIPE 'error' event on the stream. Without a listener, Node
    // treats an unhandled stream 'error' as fatal (uncaught exception), which is a much worse failure
    // mode than the ordinary "reject and let purposeCoordinator fall back to truncateTitle" path every
    // other failure here already takes. Route it through the same settle path instead.
    child.stdin.on('error', (stdinErr: Error) => {
      settleReject(stdinErr)
    })
    child.stdin.end(prompt)
  })
}
