// Reports how this app's ptys are hosted, so the renderer's xterm.js instances can turn on the matching
// Windows compatibility behavior (ITerminalOptions.windowsPty).
//
// Why the renderer has to be told at all: ConPTY does its own line wrapping and its own viewport
// bookkeeping, and neither is fully recoverable from the byte stream. xterm.js therefore gates two
// behaviors on `windowsPty` (see @xterm/xterm's ITerminalOptions docs):
//   - knowing a Windows pty is in use at all: when the terminal *gains* rows, the extra rows are taken
//     out of the scrollback instead of appended as blank rows, "because ConPTY does not behave like
//     [xterm] expect[s] scrollback to come back into the viewport, instead it makes empty rows at [the end]
//     of the viewport. Not having this behavior can result in missing data as the rows get replaced."
//     cockpit changes a pane's row count *while claude is running* every time a pane-header row appears or
//     disappears (.pane-purpose / .pane-telemetry / .pane-repo-sync in Pane.tsx, each of which shows up
//     seconds into a session), so this path is hit in normal use, not just on window resize.
//   - knowing the backend/build: reflow and the "assume wrapped when the last cell is not whitespace"
//     heuristic are only disabled for pre-21376 ConPTY / winpty, which emit no usable wrap markers.
//
// Values are kept in sync with node-pty's own backend choice, which is what actually spawns the pty:
// ptyManager.spawn() passes no `useConpty`, so node-pty's default rule decides (windowsPtyAgent.js:
// `this._useConpty = this._getWindowsBuildNumber() >= 18309`, with the build number parsed out of
// `os.release()` -- both mirrored below).
import * as os from 'node:os'
import type { WindowsPtyInfo } from '../../shared/ipc'

/** node-pty's own threshold for preferring ConPTY over winpty (windowsPtyAgent.js). */
const CONPTY_MIN_BUILD_NUMBER = 18309

/** Parses the build number out of a Windows `os.release()` string ("10.0.26200" -> 26200) using node-pty's
 * own pattern, so this never disagrees with the backend node-pty actually picked. Returns 0 when the
 * string does not look like a Windows version at all. */
export function parseWindowsBuildNumber(release: string): number {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(release)
  if (!match) return 0
  return Number.parseInt(match[3], 10)
}

/**
 * The `windowsPty` descriptor for a pty hosted on `platform` running Windows release `release`, or null
 * when there is nothing to compensate for: a non-Windows host, or a Windows release whose build number
 * cannot be read (every windowsPty behavior is keyed off knowing the build, so an unparseable release is
 * reported as "unknown" rather than guessed at).
 */
export function describeWindowsPty(platform: string, release: string): WindowsPtyInfo | null {
  if (platform !== 'win32') return null
  const buildNumber = parseWindowsBuildNumber(release)
  if (buildNumber === 0) return null
  return {
    backend: buildNumber >= CONPTY_MIN_BUILD_NUMBER ? 'conpty' : 'winpty',
    buildNumber
  }
}

/** describeWindowsPty() for the host this main process is running on. */
export function describeHostWindowsPty(): WindowsPtyInfo | null {
  return describeWindowsPty(process.platform, os.release())
}
