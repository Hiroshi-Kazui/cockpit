// Diagnostic-only recorder for a pane's raw pty stream. Writes an append-only JSONL event log per pane so a
// rendering artifact seen once in a real session can be replayed into xterm.js as many times as needed
// (the terminal-corruption reports are intermittent and no synthetic reproduction has matched them).
//
// Off unless COCKPIT_PTY_LOG_DIR is set, so a normal launch neither opens a file nor touches this path.
// Nothing is interpreted or transformed: `out` carries the pty bytes exactly as node-pty produced them, and
// `resize` records the cols/rows the app pushed back, which is what a faithful replay needs. Keystrokes are
// deliberately NOT recorded -- whatever the user typed is already echoed in the output stream, and a
// keystroke log would be a second, needless copy of it.
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { PaneIndex } from '../../shared/ipc'

export type PtyRecordEvent =
  | { t: number; k: 'spawn'; cols: number; rows: number; cwd: string }
  | { t: number; k: 'out'; d: string }
  | { t: number; k: 'resize'; cols: number; rows: number }
  | { t: number; k: 'exit'; code: number }

/** A record event minus its timestamp. Distributes over the union member-by-member, which a bare
 * `Omit<PtyRecordEvent, 't'>` does not (it would collapse to just the shared keys). */
type WithoutTimestamp<T> = T extends unknown ? Omit<T, 't'> : never
type PtyRecordPayload = WithoutTimestamp<PtyRecordEvent>

export interface PtyRecorder {
  spawned(pane: PaneIndex, cwd: string, cols: number, rows: number): void
  data(pane: PaneIndex, chunk: string): void
  resized(pane: PaneIndex, cols: number, rows: number): void
  exited(pane: PaneIndex, exitCode: number): void
}

/** One JSONL line for `event`. Pure, so the log format is pinned by tests rather than by inspection. */
export function formatRecordLine(event: PtyRecordEvent): string {
  return JSON.stringify(event) + '\n'
}

/** `<dir>/pane<index>-<startedAt>.jsonl` -- one file per spawn, so a pane restarted mid-session never
 * interleaves two ptys into one log. */
export function recordFileName(pane: PaneIndex, startedAt: number): string {
  return `pane${pane}-${startedAt}.jsonl`
}

/**
 * A recorder writing under `dir`, or null when `dir` is null/empty (the normal, disabled case).
 * `now` is injectable so tests do not depend on wall-clock time.
 */
export function createPtyRecorder(
  dir: string | null | undefined,
  now: () => number = Date.now
): PtyRecorder | null {
  if (dir === null || dir === undefined || dir.length === 0) return null
  fs.mkdirSync(dir, { recursive: true })

  const files = new Map<PaneIndex, { file: string; startedAt: number }>()

  function append(pane: PaneIndex, event: PtyRecordPayload): void {
    const open = files.get(pane)
    if (!open) return
    // The spread reconstructs exactly the union member `event` came from; TypeScript cannot follow that
    // through a generic spread, hence the assertion (no `any` involved).
    const line = formatRecordLine({ ...event, t: now() - open.startedAt } as PtyRecordEvent)
    // Synchronous appends: this path only runs when a developer explicitly asked for a recording, and
    // ordering of the log must match the order the pty produced it. Failures are reported once per event
    // rather than swallowed (CLAUDE.md: silent failure 禁止) but never break the session being recorded.
    try {
      fs.appendFileSync(open.file, line, 'utf-8')
    } catch (err) {
      console.error(`[ptyRecorder] failed to append to ${open.file}:`, err)
    }
  }

  return {
    spawned(pane, cwd, cols, rows) {
      const startedAt = now()
      files.set(pane, { file: path.join(dir, recordFileName(pane, startedAt)), startedAt })
      append(pane, { k: 'spawn', cols, rows, cwd })
    },
    data(pane, chunk) {
      append(pane, { k: 'out', d: chunk })
    },
    resized(pane, cols, rows) {
      append(pane, { k: 'resize', cols, rows })
    },
    exited(pane, exitCode) {
      append(pane, { k: 'exit', code: exitCode })
      files.delete(pane)
    }
  }
}

/** createPtyRecorder() driven by the process environment -- the app's only enable switch. */
export function createPtyRecorderFromEnv(
  env: Record<string, string | undefined>
): PtyRecorder | null {
  return createPtyRecorder(env.COCKPIT_PTY_LOG_DIR)
}
