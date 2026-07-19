// Tracks the two app-wide/pane-scoped usage signals used by the M3 visualization (spec §4.5):
//  - per-pane context-window usage (statusLine's contextUsedPercentage) -> pushed straight through as
//    a context-gauge reading; this is a live "how close to needing /compact" readout, not archival data
//    (cumulative token totals stay SessionCoordinator/`sessions` table's job, spec §4.4).
//  - the app-wide 5h/週次 rate-limit display: measured via statusLine's rate_limits when the CLI reports
//    it (Pro/Max subscribers), or a local-JSONL-token estimate against the configured plan limit when it
//    doesn't (spec §4.5's "推定" fallback, e.g. APIキーログイン).
// This is the module that finally wires shared/statusline.ts's contextUsedPercentage/rateLimits fields
// through to the renderer -- SessionCoordinator continues to discard them and is otherwise untouched;
// both coordinators independently consume the same raw pipe messages (see main/index.ts's wiring), which
// keeps session-linking/archiving (TD-2/TD-3) and usage-visualization (spec §4.5) decoupled.
import { isPaneIndex, type PaneIndex, type UsageDisplay } from '../../shared/ipc'
import { parseStatusLineMessage, type RateLimits } from '../../shared/statusline'
import type { ParsedJsonlEntry } from '../../shared/jsonl'
import {
  contextGaugeColor,
  deriveUsageDisplay,
  sumTokensInWindow,
  FIVE_HOUR_MS,
  SEVEN_DAY_MS,
  type ContextGaugeColor,
  type PlanLimitSettings,
  type UsageEvent
} from '../../shared/usage'

// Defensive bound on the in-memory local-token event log (same OOM-guard pattern as
// telemetry/pipeServer.ts's MAX_PIPE_MESSAGE_BYTES): a week of even very chatty usage should not
// remotely approach this many JSONL entries, so this only ever trims runaway growth from a pathological
// input, never normal usage.
const MAX_USAGE_EVENTS = 20_000

export interface UsageCoordinatorDeps {
  onPaneContextUsage: (pane: PaneIndex, usedPercentage: number, color: ContextGaugeColor) => void
  onUsageDisplay: (display: UsageDisplay) => void
  getPlanLimitSettings: () => PlanLimitSettings
  /** Notifies the idle-fallback scheduler (usageFallbackScheduler.ts) that "やり取り" happened
   * somewhere -- resets its idle clock. Never triggers a fetch itself. */
  noteActivity: () => void
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  now?: () => number
}

export class UsageCoordinator {
  private readonly events: UsageEvent[] = []
  private latestRateLimits: RateLimits | null = null
  private readonly now: () => number

  constructor(private readonly deps: UsageCoordinatorDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Entry point for a raw JSON-Lines message parsed off the telemetry pipe (the same raw payload
   * SessionCoordinator.onRawMessage also receives independently, see main/index.ts). Never throws. */
  onRawMessage(raw: unknown): void {
    const message = parseStatusLineMessage(raw)
    if (!message || message.pane === null || !isPaneIndex(message.pane)) return

    this.deps.noteActivity()

    if (message.contextUsedPercentage !== null) {
      this.deps.onPaneContextUsage(
        message.pane,
        message.contextUsedPercentage,
        contextGaugeColor(message.contextUsedPercentage)
      )
    }

    if (message.rateLimits !== null) {
      this.latestRateLimits = message.rateLimits
      this.refreshDisplay()
    }
  }

  /** Called by the archiver (via main/index.ts) whenever new JSONL lines were parsed for any session --
   * feeds the local-estimate token window and counts as "やり取り" activity for idle-fallback purposes. */
  onJsonlEntries(entries: readonly ParsedJsonlEntry[]): void {
    if (entries.length === 0) return
    this.deps.noteActivity()

    for (const entry of entries) {
      if (entry.timestampMs === null || !entry.usage) continue
      const totalTokens =
        entry.usage.inputTokens +
        entry.usage.outputTokens +
        entry.usage.cacheReadTokens +
        entry.usage.cacheCreationTokens
      this.events.push({ timestampMs: entry.timestampMs, totalTokens })
    }
    this.pruneEvents()
    this.refreshDisplay()
  }

  /** Called once the single-shot idle fallback fetch (usageFallbackScheduler.ts) resolves. `null` means
   * the fetch failed or returned nothing usable -- the display simply stays whatever it already was
   * (still estimated, if that's what it was). */
  onFallbackFetched(rateLimits: RateLimits | null): void {
    if (rateLimits === null) return
    this.latestRateLimits = rateLimits
    this.refreshDisplay()
  }

  /** Recomputes and pushes the current usage display. Public so IPC handlers can force a refresh right
   * after the user changes plan-limit settings (registerIpcHandlers) -- otherwise a settings change
   * would only visibly take effect on the next statusLine/JSONL event. */
  refreshDisplay(): void {
    const now = this.now()
    const display = deriveUsageDisplay({
      rateLimits: this.latestRateLimits,
      localEstimate: {
        fiveHourTokens: sumTokensInWindow(this.events, now, FIVE_HOUR_MS),
        weeklyTokens: sumTokensInWindow(this.events, now, SEVEN_DAY_MS)
      },
      planLimits: this.deps.getPlanLimitSettings()
    })
    this.deps.onUsageDisplay(display)
  }

  private pruneEvents(): void {
    const cutoff = this.now() - SEVEN_DAY_MS
    while (this.events.length > 0 && this.events[0].timestampMs < cutoff) {
      this.events.shift()
    }
    if (this.events.length > MAX_USAGE_EVENTS) {
      this.events.splice(0, this.events.length - MAX_USAGE_EVENTS)
    }
  }
}
