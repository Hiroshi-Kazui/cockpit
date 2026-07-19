// Owns node-pty process lifecycle per pane. The only module allowed to touch node-pty directly
// (CLAUDE.md: 副作用の集約). Raw data passthrough only — no interpretation of pty output (spec §4.1).
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { PaneIndex } from '../../shared/ipc'
import { buildSpawnCommand, resolveClaude } from './resolveClaude'
import type { TelemetryLaunchConfig } from '../telemetry/telemetryLaunch'

export interface PtyManagerEvents {
  onData: (pane: PaneIndex, data: string) => void
  onExit: (pane: PaneIndex, exitCode: number, signal: number | undefined) => void
}

export interface PtyManagerDeps {
  events: PtyManagerEvents
  getClaudePathOverride: () => string | null
  /** Generates the per-launch `--settings` file + telemetry env vars (spec §4.3, TD-4). Called once per
   * spawn(), i.e. once per fresh "claude 起動" click -- this is the env-injection extension point. */
  prepareTelemetry: (pane: PaneIndex) => TelemetryLaunchConfig
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 30

/** Filters out undefined values so the result is honestly typed as Record<string, string> (no `as` type lie). */
function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

export class PtyManager {
  private readonly panes = new Map<PaneIndex, IPty>()
  // FIX (architect, M4 iter2 #4): spawn() below implicitly kills a pane's existing pty when respawning
  // it (e.g. TD-7 "再開" while a stale process is still shutting down). node-pty's kill() is
  // fire-and-forget -- the *old* process's real onExit event still arrives asynchronously, potentially
  // after the *new* process has already been registered for the same pane. Without this guard, that
  // stale onExit would report the pane as exited and (via main/index.ts's onExit wiring) dispose the
  // newly-armed PurposeCoordinator launch watcher for the pty that is actually still running. Each
  // spawn() gets a fresh generation number; onData/onExit closures capture it and only forward to
  // `deps.events` while it is still the pane's current generation, so a superseded instance's events are
  // silently dropped instead of corrupting the live one's state. kill() below deletes the pane's
  // `generations` entry (kept symmetric with `panes`, M4 FIX iter3 #4): a *missing* entry is treated by
  // onData/onExit as "not superseded", so an explicit kill() with no respawn still lets that process's
  // own (still forthcoming) onExit propagate normally -- only an actual respawn (which re-populates the
  // entry with a new generation) causes the prior instance's late events to be dropped.
  private readonly generations = new Map<PaneIndex, number>()
  private nextGeneration = 0

  constructor(private readonly deps: PtyManagerDeps) {}

  /**
   * Spawn claude in the given pane's cwd. `extraArgs` (e.g. `['--continue']` for the M4 one-click
   * "再開" resume flow, TD-7) are appended after the app's own `--settings` flag. Throws
   * ClaudeResolutionError (via resolveClaude) if the CLI cannot be located — callers (IPC handler)
   * must propagate this to the renderer (AC #9).
   */
  spawn(pane: PaneIndex, cwd: string, extraArgs: readonly string[] = []): { pid: number } {
    if (this.panes.has(pane)) {
      this.kill(pane)
    }
    const telemetry = this.deps.prepareTelemetry(pane)
    const resolution = resolveClaude(this.deps.getClaudePathOverride())
    const { command, args } = buildSpawnCommand(resolution, [
      '--settings',
      telemetry.settingsPath,
      ...extraArgs
    ])
    const generation = ++this.nextGeneration
    this.generations.set(pane, generation)
    const proc = pty.spawn(command, args, {
      name: 'xterm-color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      env: cleanEnv({ ...process.env, ...telemetry.extraEnv })
    })
    proc.onData((data) => {
      // A pane with no `generations` entry (explicit kill(), never respawned) is not superseded --
      // only an entry that exists *and* names a different generation means a respawn has happened.
      const currentGeneration = this.generations.get(pane)
      if (currentGeneration !== undefined && currentGeneration !== generation) return
      this.deps.events.onData(pane, data)
    })
    proc.onExit(({ exitCode, signal }) => {
      // Only clear the map entry if it's still this exact instance (a newer spawn may already have
      // replaced it while this exit event was in flight).
      if (this.panes.get(pane) === proc) {
        this.panes.delete(pane)
      }
      const currentGeneration = this.generations.get(pane)
      if (currentGeneration !== undefined && currentGeneration !== generation) return
      this.deps.events.onExit(pane, exitCode, signal)
    })
    this.panes.set(pane, proc)
    return { pid: proc.pid }
  }

  write(pane: PaneIndex, data: string): void {
    const proc = this.panes.get(pane)
    if (!proc) {
      throw new Error(`No claude process is running in pane ${pane}`)
    }
    proc.write(data)
  }

  /** Propagates xterm.js cols/rows to the pty (TD-5). No-op if the pane has no running process yet. */
  resize(pane: PaneIndex, cols: number, rows: number): void {
    const proc = this.panes.get(pane)
    if (!proc) return
    proc.resize(cols, rows)
  }

  kill(pane: PaneIndex): void {
    const proc = this.panes.get(pane)
    if (!proc) return
    proc.kill()
    this.panes.delete(pane)
    // Symmetric with `panes` above. Deleting (rather than merely leaving it stale) is safe for the
    // generation guard: onData/onExit above treat a *missing* entry as "not superseded", so this
    // process's own still-forthcoming exit event continues to propagate normally when nothing
    // respawns the pane afterwards. If spawn() *does* respawn the pane (including the implicit kill()
    // it issues on itself just above its own generation bump), it immediately re-populates this entry
    // with the new generation right after calling kill(), so the guard still catches genuinely stale
    // events from the instance being replaced.
    this.generations.delete(pane)
  }

  killAll(): void {
    for (const pane of [...this.panes.keys()]) {
      this.kill(pane)
    }
  }

  isRunning(pane: PaneIndex): boolean {
    return this.panes.has(pane)
  }
}
