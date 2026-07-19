// Pure usage/limit calculations for the M3 visualization (spec §4.5): the per-pane context-consumption
// gauge's color thresholds, the status bar's 5h/週次 remaining-% + reset-time display, and the
// rate_limits-empty -> local-estimate fallback (with its plan-preset token budgets). No side effects,
// no Electron/Node dependency, and no I/O -- everything here is a pure function of its inputs so it is
// exhaustively unit-testable (CLAUDE.md: "集計・残量計算は shared/ の純関数").
import type { RateLimits } from './statusline'

// ---- percentage clamping ----

/** Clamps to [0, 100] and normalizes non-finite input to 0, so a momentarily out-of-range or malformed
 * statusLine/estimate reading always resolves to a definite, displayable value instead of NaN/Infinity
 * propagating into the UI. */
export function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}

// ---- context-consumption gauge (pane header, spec §4.5) ----

export type ContextGaugeColor = 'green' | 'orange' | 'red'

/** spec §4.5: 〜59% 緑 / 60〜84% オレンジ / 85%〜 赤 (compact が必要になるまでの目安の色分け). */
export function contextGaugeColor(usedPercentage: number): ContextGaugeColor {
  const clamped = clampPercentage(usedPercentage)
  if (clamped >= 85) return 'red'
  if (clamped >= 60) return 'orange'
  return 'green'
}

// ---- remaining-% (spec §4.5: "100 − used_percentage") ----

export function remainingPercentage(usedPercentage: number): number {
  return 100 - clampPercentage(usedPercentage)
}

// ---- status-bar remaining-quota gauge color (M3 FIX iteration 2, minor #5) ----

export type RemainingGaugeColor = 'ok' | 'mid' | 'low'

/** Danger-codes the status bar's 5h/週次 remaining-quota gauge fill by how little quota is left
 * (thresholds match mocks/cockpit-storyboard.html's `fillClass`: >=50% ok / 25-49% mid / <25% low),
 * rather than by measured-vs-estimated source. The measured/estimated distinction is carried separately
 * by the "推定" badge (isEstimatedDisplay) so the two concerns aren't double-encoded onto the same color. */
export function remainingPercentageColor(remaining: number): RemainingGaugeColor {
  const clamped = clampPercentage(remaining)
  if (clamped >= 50) return 'ok'
  if (clamped >= 25) return 'mid'
  return 'low'
}

// ---- plan-limit presets for the estimated fallback (spec §4.5, §5 app_settings.plan_limit_*) ----

export type PlanPreset = 'pro' | 'max5x' | 'max20x' | 'custom'

export interface PlanTokenLimits {
  fiveHourTokens: number
  weeklyTokens: number
}

/**
 * Rough default token budgets per Claude Code plan tier, used only to seed the "推定" fallback when
 * rate_limits is unavailable (spec §4.5). Anthropic publishes these tiers' relative multipliers (Max
 * 5x/20x = 5x/20x the Pro tier) but not an exact raw-token quota -- actual limits are message/session
 * based and vary with model and usage pattern. These numbers are therefore an intentionally rough,
 * order-of-magnitude starting point, NOT a verified quota; `resolvePlanTokenLimits` always prefers a
 * user-supplied custom override (spec's "手動調整可") over these defaults.
 */
export const PLAN_PRESET_TOKEN_LIMITS: Record<Exclude<PlanPreset, 'custom'>, PlanTokenLimits> = {
  pro: { fiveHourTokens: 1_000_000, weeklyTokens: 7_000_000 },
  max5x: { fiveHourTokens: 5_000_000, weeklyTokens: 35_000_000 },
  max20x: { fiveHourTokens: 20_000_000, weeklyTokens: 140_000_000 }
}

export interface PlanLimitSettings {
  preset: PlanPreset
  customFiveHourTokens: number | null
  customWeeklyTokens: number | null
}

/** Resolves the effective token budget: an explicit per-window custom override always wins (spec's
 * "手動調整可"); otherwise falls back to the selected preset's default (falling back further to 'pro'
 * when preset is 'custom' but a given window has no override, so the result is always well-defined). */
export function resolvePlanTokenLimits(settings: PlanLimitSettings): PlanTokenLimits {
  const presetKey = settings.preset === 'custom' ? 'pro' : settings.preset
  const base = PLAN_PRESET_TOKEN_LIMITS[presetKey]
  return {
    fiveHourTokens: settings.customFiveHourTokens ?? base.fiveHourTokens,
    weeklyTokens: settings.customWeeklyTokens ?? base.weeklyTokens
  }
}

/** Percentage used, clamped to [0,100]. A non-positive limit resolves to 0 rather than Infinity/NaN so
 * a misconfigured custom limit degrades safely instead of poisoning the display. */
export function estimateUsedPercentage(tokensUsedInWindow: number, tokenLimit: number): number {
  if (tokenLimit <= 0) return 0
  return clampPercentage((tokensUsedInWindow / tokenLimit) * 100)
}

// ---- windowed local token aggregation feeding the estimate (spec §4.4/§4.5: "ローカルJSONL集計") ----

export interface UsageEvent {
  timestampMs: number
  totalTokens: number
}

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

/** Sums totalTokens across events whose timestampMs falls in (nowMs - windowMs, nowMs] -- pure; the
 * caller (main/telemetry/usageCoordinator.ts) owns accumulating/pruning the event log itself. */
export function sumTokensInWindow(
  events: readonly UsageEvent[],
  nowMs: number,
  windowMs: number
): number {
  const cutoff = nowMs - windowMs
  return events
    .filter((e) => e.timestampMs > cutoff && e.timestampMs <= nowMs)
    .reduce((sum, e) => sum + e.totalTokens, 0)
}

// ---- composed status-bar display (measured vs estimated per window, spec §4.5) ----

export type UsageSource = 'measured' | 'estimated'

export interface RateLimitWindowDisplay {
  source: UsageSource
  usedPercentage: number
  remainingPercentage: number
  resetsAtMs: number | null
}

export interface UsageDisplay {
  fiveHour: RateLimitWindowDisplay
  weekly: RateLimitWindowDisplay
}

export interface UsageDisplayInput {
  rateLimits: RateLimits | null
  localEstimate: { fiveHourTokens: number; weeklyTokens: number }
  planLimits: PlanLimitSettings
}

function buildWindowDisplay(
  source: UsageSource,
  usedPercentage: number,
  resetsAtMs: number | null
): RateLimitWindowDisplay {
  const used = clampPercentage(usedPercentage)
  return {
    source,
    usedPercentage: used,
    remainingPercentage: remainingPercentage(used),
    resetsAtMs
  }
}

/** Per-window measured-vs-estimated decision: a window is "measured" when its own statusLine
 * used_percentage is present (spec §4.5's normal Pro/Max path); otherwise it falls back to the local
 * token estimate for that specific window. Deciding per window (rather than an all-or-nothing switch
 * on the whole rate_limits object) degrades gracefully even in the unlikely case only one window's data
 * is present. */
function deriveWindowDisplay(
  measured: { usedPercentage: number | null; resetsAt: number | null } | null | undefined,
  estimatedTokensInWindow: number,
  estimatedTokenLimit: number
): RateLimitWindowDisplay {
  if (measured && measured.usedPercentage !== null) {
    return buildWindowDisplay('measured', measured.usedPercentage, measured.resetsAt ?? null)
  }
  return buildWindowDisplay(
    'estimated',
    estimateUsedPercentage(estimatedTokensInWindow, estimatedTokenLimit),
    null
  )
}

/** spec §4.5: prefer the Anthropic-server-measured rate_limits when present; otherwise fall back to a
 * local-JSONL-token estimate against the configured plan limit. The renderer (StatusBar) shows a "推定"
 * badge whenever either window's `source` is `'estimated'` (see `isEstimatedDisplay`). */
export function deriveUsageDisplay(input: UsageDisplayInput): UsageDisplay {
  const limits = resolvePlanTokenLimits(input.planLimits)
  return {
    fiveHour: deriveWindowDisplay(
      input.rateLimits?.fiveHour,
      input.localEstimate.fiveHourTokens,
      limits.fiveHourTokens
    ),
    weekly: deriveWindowDisplay(
      input.rateLimits?.sevenDay,
      input.localEstimate.weeklyTokens,
      limits.weeklyTokens
    )
  }
}

/** spec §4.5's "推定" badge condition: true when any part of the display fell back to the local
 * estimate rather than a measured rate_limits value.
 *
 * M3 FIX (minor #4): the empty-`rate_limits` -> estimated-fallback path (AC #6) has only been verified
 * against real captured statusLine payloads that *did* carry non-empty `rate_limits` (see
 * shared/statusline.ts's header comment) -- no account available in this environment has produced an
 * empty/absent `rate_limits`, so the fallback path itself could not be captured live. That is an
 * absence-of-sample-data constraint, not a known defect: this function and `deriveWindowDisplay` above
 * are pure and operate purely on field presence/absence, so the field-absence cases (`rateLimits` entirely
 * null, one window entirely null, a window present but its `usedPercentage` null) are exercised directly
 * by usage.test.ts's `deriveUsageDisplay`/`isEstimatedDisplay` describe blocks without needing a real
 * account in that state. */
export function isEstimatedDisplay(display: UsageDisplay): boolean {
  return display.fiveHour.source === 'estimated' || display.weekly.source === 'estimated'
}

// ---- idle-triggered single-shot fallback fetch gating (spec §4.5, AC #5: no periodic polling) ----

export const IDLE_FALLBACK_THRESHOLD_MS = 5 * 60 * 1000

/** True once at least `idleThresholdMs` has elapsed since the last observed activity. Pure predicate
 * over explicit timestamps; the *scheduling* (main/telemetry/usageFallbackScheduler.ts) is driven by a
 * single reset-on-activity setTimeout, never a setInterval/cron, so in practice this is evaluated at
 * most once per idle period. */
export function isIdleFallbackDue(
  lastActivityAtMs: number,
  nowMs: number,
  idleThresholdMs: number
): boolean {
  return nowMs - lastActivityAtMs >= idleThresholdMs
}
