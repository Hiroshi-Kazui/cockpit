// Pure decision logic for TD-1's launch-completion detection: given timestamps for when a pane's pty
// was spawned, when (if ever) the first statusLine pipe event was observed, and when (if ever) pty
// output last arrived, decide whether "launch complete" holds at `nowMs` and why. The actual
// setTimeout/clearTimeout plumbing that drives repeated calls to this function over wall-clock time
// lives in main/pty/launchReadinessWatcher.ts (side-effecting); this file has no I/O so the priority
// rules (statusLine primary signal / 700ms output-quiet fallback / 10s hard cap) are unit-testable
// without real timers.
export const LAUNCH_QUIET_MS = 700
export const LAUNCH_TIMEOUT_MS = 10_000

export type LaunchReadyReason = 'statusline' | 'quiet' | 'timeout'

export interface LaunchReadinessInputs {
  /** When the pty for this launch was spawned (epoch ms). */
  spawnedAtMs: number
  /** When the first statusLine pipe event for this pane's launch was observed, or null if none yet. */
  statusLineEventAtMs: number | null
  /** When pty output last arrived for this launch, or null if none yet. */
  lastPtyOutputAtMs: number | null
  /** The instant to evaluate readiness at. */
  nowMs: number
  quietMs?: number
  timeoutMs?: number
}

export type LaunchReadinessResult = { ready: false } | { ready: true; reason: LaunchReadyReason }

/**
 * TD-1: two-stage detection with a hard cap.
 * 1. Primary signal: the first statusLine event received after spawn -- takes precedence whenever
 *    present, regardless of the other two conditions.
 * 2. Fallback: 700ms of pty-output quiet (only meaningful once at least one output chunk has arrived).
 * 3. Hard cap: 10s after spawn, ready regardless of the other two signals (a send is attempted anyway).
 */
export function evaluateLaunchReadiness(inputs: LaunchReadinessInputs): LaunchReadinessResult {
  const quietMs = inputs.quietMs ?? LAUNCH_QUIET_MS
  const timeoutMs = inputs.timeoutMs ?? LAUNCH_TIMEOUT_MS

  if (inputs.statusLineEventAtMs !== null) {
    return { ready: true, reason: 'statusline' }
  }
  if (inputs.nowMs - inputs.spawnedAtMs >= timeoutMs) {
    return { ready: true, reason: 'timeout' }
  }
  if (inputs.lastPtyOutputAtMs !== null && inputs.nowMs - inputs.lastPtyOutputAtMs >= quietMs) {
    return { ready: true, reason: 'quiet' }
  }
  return { ready: false }
}
