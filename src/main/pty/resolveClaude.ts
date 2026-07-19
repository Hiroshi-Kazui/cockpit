// Resolves the claude CLI executable and the correct spawn strategy on Windows (TD-5).
import { accessSync, constants } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export type ClaudeSpawnKind = 'exe' | 'cmd'

export interface ClaudeResolution {
  path: string
  kind: ClaudeSpawnKind
}

/** Thrown when the claude CLI cannot be located or is not a supported executable type. */
export class ClaudeResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeResolutionError'
  }
}

/**
 * Pure: classify a resolved claude path into a spawn strategy from its extension.
 * `.exe` binaries are spawned directly; `.cmd`/`.bat` npm shims require a `cmd.exe /c` wrapper
 * because node-pty/ConPTY cannot exec a shell script directly on Windows.
 */
export function classifyClaudePath(resolvedPath: string): ClaudeSpawnKind {
  const ext = path.extname(resolvedPath).toLowerCase()
  if (ext === '.exe') return 'exe'
  if (ext === '.cmd' || ext === '.bat') return 'cmd'
  throw new ClaudeResolutionError(
    `Unsupported claude executable extension "${ext}" for path: ${resolvedPath}`
  )
}

/**
 * Pure: build the { command, args } pair node-pty should spawn for a given resolution.
 * `.cmd` shims are wrapped through `cmd.exe /c` so ConPTY can execute them.
 */
export function buildSpawnCommand(
  resolution: ClaudeResolution,
  args: readonly string[]
): { command: string; args: string[] } {
  if (resolution.kind === 'exe') {
    return { command: resolution.path, args: [...args] }
  }
  return { command: 'cmd.exe', args: ['/c', resolution.path, ...args] }
}

/** Side-effecting: search PATH via `where claude`. Returns null (never throws) if not found. */
function findViaWhere(): string | null {
  try {
    const output = execFileSync('where', ['claude'], { encoding: 'utf-8' })
    const lines = output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    // Prefer a directly-executable .exe over a .cmd shim when both are on PATH.
    const exe = lines.find((l) => l.toLowerCase().endsWith('.exe'))
    return exe ?? lines[0] ?? null
  } catch {
    return null
  }
}

/**
 * Resolve the claude CLI to an absolute path + spawn kind.
 * @param manualOverride app_settings.claude_path, if the user configured one (TD-5).
 * @throws ClaudeResolutionError if resolution fails; callers must surface this to the user (AC #9).
 */
export function resolveClaude(manualOverride: string | null): ClaudeResolution {
  const candidate =
    manualOverride && manualOverride.trim().length > 0 ? manualOverride : findViaWhere()
  if (!candidate) {
    throw new ClaudeResolutionError(
      'claude CLI が PATH 上に見つかりませんでした。設定で claude の実行ファイルパスを指定してください。'
    )
  }
  try {
    accessSync(candidate, constants.F_OK)
  } catch {
    throw new ClaudeResolutionError(`claude の実行ファイルが見つかりません: ${candidate}`)
  }
  const kind = classifyClaudePath(candidate)
  return { path: candidate, kind }
}
