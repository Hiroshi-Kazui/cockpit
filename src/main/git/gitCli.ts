// The sole child_process.execFile window for git invocations (ADR-0013/D-3, D-8). Every git command this
// app ever runs passes through runGit() so the non-interactive-env + per-command-timeout + never-throw
// guarantees apply uniformly. main/git/repoSync.ts owns *which* git subcommands/args to run and when --
// this module only knows how to run *a* git command safely. Mirrors main/pty/titleGenerator.ts's
// injectable-execFile pattern so tests never spawn a real git process.
import { execFile as nodeExecFile, type ExecFileException } from 'node:child_process'

export type GitCliResult =
  | { ok: true; stdout: string }
  // git executable itself could not be spawned (not installed / not on PATH) -- distinct from a git
  // command that ran and failed, so callers can report "git-unavailable" instead of a generic failure.
  | { ok: false; kind: 'enoent'; message: string }
  // D-8: killed by our own timeout rather than exiting on its own (most likely an auth prompt git is
  // silently blocked on, since GIT_TERMINAL_PROMPT=0 etc. below should prevent that in the first place).
  | { ok: false; kind: 'timeout'; message: string }
  | { ok: false; kind: 'error'; message: string }

/** D-8: query commands (rev-parse/status/branch/remote/symbolic-ref) get 5s; checkout 20s; pull 30s. */
export const GIT_TIMEOUT_MS = { query: 5_000, checkout: 20_000, pull: 30_000 } as const

/** Narrow shape of node:child_process.execFile this module uses -- injectable so tests never spawn a
 * real process (same pattern as titleGenerator.ts's TitleGeneratorExecFile). */
export type GitExecFile = (
  file: string,
  args: readonly string[],
  options: {
    cwd: string
    timeout: number
    windowsHide: boolean
    maxBuffer: number
    env: Record<string, string>
  },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void
) => void

const defaultExecFile: GitExecFile = (file, args, options, callback) =>
  nodeExecFile(file, args as string[], { ...options, encoding: 'utf-8' }, callback)

/** D-8: non-interactive so an authentication prompt (Windows Git Credential Manager can pop a GUI) never
 * blocks the "＋ 新規セッション" button indefinitely. Overrides (not merely omits) GIT_ASKPASS/SSH_ASKPASS
 * so a value inherited from the developer's own shell environment is squashed, not just left unset --
 * mirrors main/pty/ptyManager.ts's cleanEnv style (filter out undefined so the result is honestly typed).
 *
 * FIX M1 (review iter1): also forces the C locale (LC_ALL/LANG/LANGUAGE) so git's own stderr text is always
 * English regardless of the machine's configured locale -- repoSync.ts's `isNotARepoError` (and any future
 * stderr pattern match) would otherwise silently stop recognizing "not a git repository" on a non-English
 * system, misclassifying it as a generic `failed` outcome instead of `not-a-repo`. */
function buildNonInteractiveEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GCM_INTERACTIVE = 'never'
  env.GIT_ASKPASS = ''
  env.SSH_ASKPASS = ''
  env.LC_ALL = 'C'
  env.LANG = 'C'
  env.LANGUAGE = ''
  return env
}

/**
 * Runs `git <args>` in `cwd`, never throwing (ADR-0013/D-2: a git failure must never abort session
 * launch). ENOENT (git executable not found) and a timeout-triggered kill are reported as distinct, typed
 * outcomes so callers can tell "git isn't installed" apart from "git hung" apart from "git exited
 * non-zero" (R-2/R-7).
 */
export function runGit(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  execFile: GitExecFile = defaultExecFile
): Promise<GitCliResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        env: buildNonInteractiveEnv()
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ ok: true, stdout })
          return
        }
        if (err.code === 'ENOENT') {
          resolve({ ok: false, kind: 'enoent', message: err.message })
          return
        }
        if (err.killed === true) {
          resolve({
            ok: false,
            kind: 'timeout',
            message: `git ${args.join(' ')} timed out after ${timeoutMs}ms`
          })
          return
        }
        resolve({
          ok: false,
          kind: 'error',
          message: stderr.trim().length > 0 ? stderr.trim() : err.message
        })
      }
    )
  })
}
