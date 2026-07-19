// Side-effecting per-launch driver for TD-1's launch-completion detection. Owns the real
// setTimeout/clearTimeout plumbing (statusLine-event listener, 700ms output-quiet timer, 10s hard-cap
// timer) and the "fire exactly once" guard; the actual priority decision at each check is delegated to
// the pure evaluateLaunchReadiness (shared/launchReadiness.ts) so that logic stays unit-testable
// without real timers. One instance is created per pane per "新規セッション" launch by
// main/pty/purposeCoordinator.ts and discarded once it fires or the launch is cancelled (pty exited).
import {
  LAUNCH_QUIET_MS,
  LAUNCH_TIMEOUT_MS,
  evaluateLaunchReadiness,
  type LaunchReadyReason
} from '../../shared/launchReadiness'

export interface LaunchReadinessWatcherDeps {
  onReady: (reason: LaunchReadyReason) => void
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  now?: () => number
  quietMs?: number
  timeoutMs?: number
}

export class LaunchReadinessWatcher {
  private readonly spawnedAtMs: number
  private readonly now: () => number
  private readonly onReady: (reason: LaunchReadyReason) => void
  private readonly quietMs: number
  private readonly timeoutMs: number
  private statusLineEventAtMs: number | null = null
  private lastPtyOutputAtMs: number | null = null
  private fired = false
  private quietTimer: ReturnType<typeof setTimeout> | null = null
  private hardTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: LaunchReadinessWatcherDeps) {
    this.now = deps.now ?? Date.now
    this.onReady = deps.onReady
    this.quietMs = deps.quietMs ?? LAUNCH_QUIET_MS
    this.timeoutMs = deps.timeoutMs ?? LAUNCH_TIMEOUT_MS
    this.spawnedAtMs = this.now()
    this.hardTimer = setTimeout(() => this.check(), this.timeoutMs)
    // Never let this timer alone keep the process alive (matters for graceful app shutdown timing).
    this.hardTimer.unref?.()
  }

  /** Call on every statusLine pipe message observed for this pane after spawn (TD-1 primary signal). */
  onStatusLineEvent(): void {
    if (this.fired) return
    if (this.statusLineEventAtMs === null) this.statusLineEventAtMs = this.now()
    this.check()
  }

  /** Call on every pty data chunk observed for this pane after spawn (TD-1 fallback signal). */
  onPtyOutput(): void {
    if (this.fired) return
    this.lastPtyOutputAtMs = this.now()
    if (this.quietTimer) clearTimeout(this.quietTimer)
    this.quietTimer = setTimeout(() => this.check(), this.quietMs)
    this.quietTimer.unref?.()
  }

  /** Cancels this watcher without firing (e.g. the pty exited before readiness was ever reached). */
  dispose(): void {
    this.fired = true
    this.clearTimers()
  }

  private check(): void {
    if (this.fired) return
    const result = evaluateLaunchReadiness({
      spawnedAtMs: this.spawnedAtMs,
      statusLineEventAtMs: this.statusLineEventAtMs,
      lastPtyOutputAtMs: this.lastPtyOutputAtMs,
      nowMs: this.now(),
      quietMs: this.quietMs,
      timeoutMs: this.timeoutMs
    })
    if (result.ready) {
      this.fired = true
      this.clearTimers()
      this.onReady(result.reason)
    }
  }

  private clearTimers(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer)
    if (this.hardTimer) clearTimeout(this.hardTimer)
    this.quietTimer = null
    this.hardTimer = null
  }
}
