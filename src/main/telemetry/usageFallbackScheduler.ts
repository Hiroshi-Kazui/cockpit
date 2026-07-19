// Idle-triggered single-shot fallback usage fetch (spec §4.5, AC #5): schedules at most one
// GET /api/oauth/usage call per idle period. Uses a single reset-on-activity setTimeout -- never a
// setInterval/cron -- so a fetch only ever fires as the direct consequence of a state transition (no
// activity for `idleThresholdMs`), and this module never re-arms itself on its own while idle continues:
// only a fresh noteActivity() call starts tracking the next idle period. This is what keeps the fetch
// genuinely "単発" per spec §4.5's explicit prohibition on periodic polling of this endpoint (documented
// to rate-limit aggressively even at low frequency).
import { IDLE_FALLBACK_THRESHOLD_MS, isIdleFallbackDue } from '../../shared/usage'

export interface UsageFallbackSchedulerDeps {
  fetchFallback: () => Promise<void>
  idleThresholdMs?: number
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  now?: () => number
}

export class UsageFallbackScheduler {
  private readonly idleThresholdMs: number
  private readonly now: () => number
  private readonly fetchFallback: () => Promise<void>
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastActivityAtMs: number

  constructor(deps: UsageFallbackSchedulerDeps) {
    this.idleThresholdMs = deps.idleThresholdMs ?? IDLE_FALLBACK_THRESHOLD_MS
    this.now = deps.now ?? Date.now
    this.fetchFallback = deps.fetchFallback
    this.lastActivityAtMs = this.now()
    this.arm()
  }

  /** Call whenever any pane produces telemetry (statusLine message accepted, or new JSONL entries
   * parsed) -- i.e. "やり取り" happened somewhere. Resets the idle clock; does NOT itself trigger a
   * fetch. */
  noteActivity(): void {
    this.lastActivityAtMs = this.now()
    this.arm()
  }

  /** Stops the pending timer (app quit). No-op if nothing is scheduled. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    const armedAt = this.lastActivityAtMs
    this.timer = setTimeout(() => {
      this.timer = null
      // Defensive re-check rather than trusting the timer's own delay blindly -- if this class is ever
      // adjusted to reuse/extend a timer instead of always clearing+recreating, this still only fires the
      // fetch for a period that has genuinely reached the threshold.
      if (!isIdleFallbackDue(armedAt, this.now(), this.idleThresholdMs)) return
      // Fire-and-forget: deliberately no .catch() logging here -- fetchFallback (see
      // main/telemetry/oauthUsageClient.ts via main/index.ts's wiring) already never rejects, it always
      // resolves (to null on any failure) so there is nothing for a rejection handler to do here. This
      // class intentionally never re-arms itself afterward; only another noteActivity() call schedules
      // the next single-shot attempt.
      void this.fetchFallback()
    }, this.idleThresholdMs)
  }
}
