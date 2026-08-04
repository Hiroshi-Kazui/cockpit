// Resolves the claude CLI executable and the correct spawn strategy on Windows (TD-5).
import { accessSync, constants } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export type ClaudeSpawnKind = 'exe' | 'cmd'

export interface ClaudeResolution {
  path: string
  kind: ClaudeSpawnKind
}

/** Windows-executable extensions ConPTY can launch, in preference order (TD-5). */
const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat'] as const

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
 * Pure: from the lines `where claude` printed, pick the best launchable Windows executable.
 * npm installs an extensionless POSIX launcher (`claude`) alongside a `claude.cmd` shim, and
 * `where` lists the extensionless one first; ConPTY can only launch `.exe`/`.cmd`/`.bat`, so we
 * prefer those (in that order) over the extensionless entry. Falls back to the first line so an
 * extensionless-only result still flows to disk probing / a precise error downstream.
 */
export function selectClaudeCandidate(lines: readonly string[]): string | null {
  const cleaned = lines.map((l) => l.trim()).filter((l) => l.length > 0)
  for (const ext of WINDOWS_EXECUTABLE_EXTENSIONS) {
    const found = cleaned.find((l) => l.toLowerCase().endsWith(ext))
    if (found) return found
  }
  return cleaned[0] ?? null
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

/** Side-effecting: true if the path exists on disk. */
function fileExists(candidate: string): boolean {
  try {
    accessSync(candidate, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Side-effecting: given a base path (typically extensionless, e.g. npm's POSIX `claude` launcher),
 * probe for a launchable Windows sibling by appending `.exe`/`.cmd`/`.bat`. Returns the first that
 * exists, or null. This is what makes resolution work regardless of which path `where` / the user
 * hands us: the extensionless launcher and the `.cmd` shim live side by side.
 */
function probeExecutableWithExtensions(basePath: string): string | null {
  for (const ext of WINDOWS_EXECUTABLE_EXTENSIONS) {
    const withExt = basePath + ext
    if (fileExists(withExt)) return withExt
  }
  return null
}

/** Side-effecting: search PATH via `where claude`. Returns null (never throws) if not found. */
function findViaWhere(): string | null {
  try {
    const output = execFileSync('where', ['claude'], { encoding: 'utf-8' })
    return selectClaudeCandidate(output.split(/\r?\n/))
  } catch {
    return null
  }
}

/**
 * Side-effecting: turn a raw candidate into a launchable, existing path.
 * A supported extension that exists is used as-is; otherwise (extensionless npm launcher, or a
 * missing file) we probe for a `.exe`/`.cmd`/`.bat` sibling. Falls back to the raw candidate when
 * it exists so `classifyClaudePath` can surface a precise "unsupported extension" error.
 */
function resolveExecutablePath(candidate: string): string | null {
  const ext = path.extname(candidate).toLowerCase()
  const supported = (WINDOWS_EXECUTABLE_EXTENSIONS as readonly string[]).includes(ext)
  if (supported && fileExists(candidate)) return candidate
  const probed = probeExecutableWithExtensions(candidate)
  if (probed) return probed
  return fileExists(candidate) ? candidate : null
}

/**
 * Resolve the claude CLI to an absolute path + spawn kind.
 * @param manualOverride app_settings.claude_path, if the user configured one (TD-5).
 * @throws ClaudeResolutionError if resolution fails; callers must surface this to the user (AC #9).
 */
export function resolveClaude(manualOverride: string | null): ClaudeResolution {
  const candidate =
    manualOverride && manualOverride.trim().length > 0 ? manualOverride.trim() : findViaWhere()
  if (!candidate) {
    throw new ClaudeResolutionError(
      'claude CLI が PATH 上に見つかりませんでした。設定で claude の実行ファイルパスを指定してください。'
    )
  }
  const resolved = resolveExecutablePath(candidate)
  if (!resolved) {
    throw new ClaudeResolutionError(`claude の実行ファイルが見つかりません: ${candidate}`)
  }
  const kind = classifyClaudePath(resolved)
  return { path: resolved, kind }
}
