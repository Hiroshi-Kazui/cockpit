// Reports how this app's ptys are hosted, so the renderer's xterm.js instances can turn on the matching
// Windows compatibility behavior (ITerminalOptions.windowsPty) -- and, since M12 (ADR-0014), decides
// whether ptyManager.spawn() should ask node-pty for its bundled conpty.dll instead of the OS conhost one.
// Both decisions are exported from this one module on purpose (ADR-0014 D-3: "cockpit が spawn に渡した
// 事実を鏡写しする"; avoids the M10 followups "錨判定ルールの二重化" recurrence) -- ptyManager.spawn() calls
// resolveHostUseConptyDll() to build its own spawn options, and describeHostWindowsPty() below feeds that
// exact same value into the descriptor sent to the renderer, so the two can never disagree.
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
// The backend/build values are kept in sync with node-pty's own choice, which is what actually spawns the
// pty: ptyManager.spawn() passes no explicit `useConpty`, so node-pty's default rule decides
// (windowsPtyAgent.js: `this._useConpty = this._getWindowsBuildNumber() >= 18309`, with the build number
// parsed out of `os.release()` -- both mirrored below). `useConptyDll` (M12) does not change this rule at
// all -- see describeWindowsPty's doc comment for why it is still threaded through.
import * as os from 'node:os'
import type { WindowsPtyInfo } from '../../shared/ipc'

/** node-pty's own threshold for preferring ConPTY over winpty (windowsPtyAgent.js). */
const CONPTY_MIN_BUILD_NUMBER = 18309

/** Env var name for ADR-0014 D-2's escape hatch back to the OS conhost-hosted ConPTY, should the bundled
 * conpty.dll (D-1) ever regress. A diagnostic switch only -- same precedent as COCKPIT_PTY_LOG_DIR
 * (ptyRecorder.ts) -- deliberately not exposed as a UI setting. */
const DISABLE_CONPTY_DLL_ENV_VAR = 'COCKPIT_DISABLE_CONPTY_DLL'

/** Parses the build number out of a Windows `os.release()` string ("10.0.26200" -> 26200) using node-pty's
 * own pattern, so this never disagrees with the backend node-pty actually picked. Returns 0 when the
 * string does not look like a Windows version at all. */
export function parseWindowsBuildNumber(release: string): number {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(release)
  if (!match) return 0
  return Number.parseInt(match[3], 10)
}

/**
 * Whether ptyManager.spawn() should pass `useConptyDll: true` to node-pty (ADR-0014 D-1). Only the exact
 * value `'1'` opts back out to the OS conhost-hosted ConPTY (D-2); any other value -- unset, empty, or a
 * typo like `'true'` -- leaves the new (dll) behavior on, so a malformed override can never silently fall
 * back to the old backend nobody asked to restore (CLAUDE.md: silent failure 禁止 の裏返しで、既定は新挙動
 * を維持する側に倒す).
 */
export function resolveUseConptyDll(env: Record<string, string | undefined>): boolean {
  return env[DISABLE_CONPTY_DLL_ENV_VAR] !== '1'
}

/** resolveUseConptyDll() against the real process environment -- what ptyManager.spawn() actually calls
 * to decide its own spawn options. */
export function resolveHostUseConptyDll(): boolean {
  return resolveUseConptyDll(process.env)
}

/**
 * The `windowsPty` descriptor for a pty hosted on `platform` running Windows release `release`, or null
 * when there is nothing to compensate for: a non-Windows host, or a Windows release whose build number
 * cannot be read (every windowsPty behavior is keyed off knowing the build, so an unparseable release is
 * reported as "unknown" rather than guessed at).
 *
 * `useConptyDll` is accepted (M12, ADR-0014 D-3) -- not dropped -- purely so this is the single function
 * both ptyManager's spawn-time choice and this module's own renderer-facing descriptor derive their
 * answer from; it does not currently change the result. Checked against node-pty 1.1.0's own
 * windowsPtyAgent.js:
 *   - Backend/build selection (`this._useConpty = this._getWindowsBuildNumber() >= 18309` L37-38, and the
 *     conptyNative/winptyNative pick at L50) never reads `_useConptyDll` at all, so it can never turn a
 *     winpty host into a conpty one, or vice versa, nor change the reported build number.
 *   - `new ConoutConnection(term.conout, this._useConptyDll)` (L74) runs unconditionally, outside any
 *     `if (this._useConpty)` guard -- so a winpty-hosted agent's ConoutConnection also receives this
 *     value, and its own dispose() idempotency check (`if (!this._useConptyDll && this._isDisposed)
 *     return`, windowsConoutConnection.js L93) does read it. That check is never actually reached for a
 *     winpty-hosted pty in this node-pty version, though: `kill()`'s winpty branch (L162-179) never calls
 *     `_conoutSocketWorker.dispose()` at all -- only the two conpty-only branches of `kill()` do (L151,
 *     L158, both nested under the `if (this._useConpty)` at L136).
 *   - `_$onProcessExit()`/`_flushDataAndCleanUp()`/`_cleanUpProcess()` (L221-246) read `_useConptyDll`
 *     directly, with no `if (this._useConpty)` wrapper of their own -- but `_$onProcessExit` is wired up
 *     only from inside the `if (this._useConpty)` block at L88-91, so it (and the two methods it chains
 *     into) never run at all for a winpty-hosted pty, independent of `_useConptyDll`.
 */
export function describeWindowsPty(
  platform: string,
  release: string,
  useConptyDll: boolean
): WindowsPtyInfo | null {
  if (platform !== 'win32') return null
  const buildNumber = parseWindowsBuildNumber(release)
  if (buildNumber === 0) return null
  // See the doc comment above: useConptyDll does not affect this rule at all, kept as a parameter (not
  // dropped) so this stays the one function that decides both things ADR-0014 D-3 requires never drift
  // apart. `void` marks that on purpose, rather than silently accepting an unused parameter.
  void useConptyDll
  return {
    backend: buildNumber >= CONPTY_MIN_BUILD_NUMBER ? 'conpty' : 'winpty',
    buildNumber
  }
}

/** describeWindowsPty() for the host this main process is running on, fed the exact same useConptyDll
 * decision ptyManager.spawn() makes (resolveHostUseConptyDll()) -- never recomputed independently
 * (ADR-0014 D-3). */
export function describeHostWindowsPty(): WindowsPtyInfo | null {
  return describeWindowsPty(process.platform, os.release(), resolveHostUseConptyDll())
}
