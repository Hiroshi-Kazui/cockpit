// Unit tests for shared/usage.ts's pure usage/limit calculations (spec §4.5, M3 AC #1/#3/#6/#7).
import { describe, expect, it } from 'vitest'
import {
  clampPercentage,
  contextGaugeColor,
  deriveUsageDisplay,
  estimateUsedPercentage,
  isEstimatedDisplay,
  isIdleFallbackDue,
  remainingPercentage,
  remainingPercentageColor,
  resolvePlanTokenLimits,
  sumTokensInWindow,
  FIVE_HOUR_MS,
  IDLE_FALLBACK_THRESHOLD_MS,
  SEVEN_DAY_MS,
  type PlanLimitSettings,
  type UsageEvent
} from './usage'

describe('clampPercentage', () => {
  it('passes through in-range values unchanged', () => {
    expect(clampPercentage(0)).toBe(0)
    expect(clampPercentage(50)).toBe(50)
    expect(clampPercentage(100)).toBe(100)
  })

  it('clamps negative values to 0', () => {
    expect(clampPercentage(-5)).toBe(0)
  })

  it('clamps values above 100 to 100', () => {
    expect(clampPercentage(150)).toBe(100)
  })

  it('normalizes NaN/Infinity to 0', () => {
    expect(clampPercentage(NaN)).toBe(0)
    expect(clampPercentage(Infinity)).toBe(0)
    expect(clampPercentage(-Infinity)).toBe(0)
  })
})

// spec §4.5: 〜59% 緑 / 60〜84% オレンジ / 85%〜 赤 -- exhaustive boundary coverage.
describe('contextGaugeColor', () => {
  it('is green from 0 up to and including 59%', () => {
    expect(contextGaugeColor(0)).toBe('green')
    expect(contextGaugeColor(59)).toBe('green')
    expect(contextGaugeColor(59.9)).toBe('green')
  })

  it('is orange from exactly 60% up to and including 84%', () => {
    expect(contextGaugeColor(60)).toBe('orange')
    expect(contextGaugeColor(84)).toBe('orange')
    expect(contextGaugeColor(84.9)).toBe('orange')
  })

  it('is red from exactly 85% and above', () => {
    expect(contextGaugeColor(85)).toBe('red')
    expect(contextGaugeColor(100)).toBe('red')
  })

  it('clamps out-of-range input before classifying (negative -> green, >100 -> red)', () => {
    expect(contextGaugeColor(-10)).toBe('green')
    expect(contextGaugeColor(999)).toBe('red')
  })
})

describe('remainingPercentage', () => {
  it('is 100 minus used', () => {
    expect(remainingPercentage(0)).toBe(100)
    expect(remainingPercentage(59)).toBe(41)
    expect(remainingPercentage(100)).toBe(0)
  })

  it('clamps used before subtracting', () => {
    expect(remainingPercentage(-20)).toBe(100)
    expect(remainingPercentage(150)).toBe(0)
  })
})

// M3 FIX iteration 2 (minor #5): status-bar gauge fill color danger-codes remaining quota, matching
// mocks/cockpit-storyboard.html's fillClass thresholds (>=50 ok / 25-49 mid / <25 low).
describe('remainingPercentageColor', () => {
  it('is "ok" from 50% up to 100%', () => {
    expect(remainingPercentageColor(50)).toBe('ok')
    expect(remainingPercentageColor(100)).toBe('ok')
  })

  it('is "mid" from 25% up to just under 50%', () => {
    expect(remainingPercentageColor(25)).toBe('mid')
    expect(remainingPercentageColor(49.9)).toBe('mid')
  })

  it('is "low" below 25%, including 0', () => {
    expect(remainingPercentageColor(24.9)).toBe('low')
    expect(remainingPercentageColor(0)).toBe('low')
  })

  it('clamps out-of-range input before classifying (negative -> low, >100 -> ok)', () => {
    expect(remainingPercentageColor(-10)).toBe('low')
    expect(remainingPercentageColor(999)).toBe('ok')
  })
})

describe('resolvePlanTokenLimits', () => {
  it('uses the preset default when no custom override is set', () => {
    const settings: PlanLimitSettings = {
      preset: 'max5x',
      customFiveHourTokens: null,
      customWeeklyTokens: null
    }
    expect(resolvePlanTokenLimits(settings)).toEqual({
      fiveHourTokens: 5_000_000,
      weeklyTokens: 35_000_000
    })
  })

  it('prefers a custom override over the preset default (手動調整可)', () => {
    const settings: PlanLimitSettings = {
      preset: 'pro',
      customFiveHourTokens: 123,
      customWeeklyTokens: 456
    }
    expect(resolvePlanTokenLimits(settings)).toEqual({ fiveHourTokens: 123, weeklyTokens: 456 })
  })

  it('allows a partial override (only one window customized)', () => {
    const settings: PlanLimitSettings = {
      preset: 'max20x',
      customFiveHourTokens: 999,
      customWeeklyTokens: null
    }
    expect(resolvePlanTokenLimits(settings)).toEqual({
      fiveHourTokens: 999,
      weeklyTokens: 140_000_000
    })
  })

  it('falls back to the pro preset when preset is "custom" but a window has no override', () => {
    const settings: PlanLimitSettings = {
      preset: 'custom',
      customFiveHourTokens: null,
      customWeeklyTokens: null
    }
    expect(resolvePlanTokenLimits(settings)).toEqual({
      fiveHourTokens: 1_000_000,
      weeklyTokens: 7_000_000
    })
  })
})

describe('estimateUsedPercentage', () => {
  it('computes a normal ratio as a percentage', () => {
    expect(estimateUsedPercentage(250_000, 1_000_000)).toBe(25)
  })

  it('clamps to 100 when usage exceeds the limit', () => {
    expect(estimateUsedPercentage(2_000_000, 1_000_000)).toBe(100)
  })

  it('resolves to 0 for a non-positive limit instead of NaN/Infinity', () => {
    expect(estimateUsedPercentage(100, 0)).toBe(0)
    expect(estimateUsedPercentage(100, -50)).toBe(0)
  })

  it('resolves to 0 for zero usage', () => {
    expect(estimateUsedPercentage(0, 1_000_000)).toBe(0)
  })
})

describe('sumTokensInWindow', () => {
  const events: UsageEvent[] = [
    { timestampMs: 1000, totalTokens: 10 },
    { timestampMs: 2000, totalTokens: 20 },
    { timestampMs: 3000, totalTokens: 30 }
  ]

  it('sums only events within the trailing window', () => {
    // window = (now - 1500, now] with now=3000 -> cutoff 1500 excludes the 1000 event
    expect(sumTokensInWindow(events, 3000, 1500)).toBe(50)
  })

  it('excludes an event exactly at the cutoff boundary (window is open at the start)', () => {
    // cutoff = 3000 - 2000 = 1000; the event at exactly 1000 must be excluded
    expect(sumTokensInWindow(events, 3000, 2000)).toBe(50) // 2000 + 3000 events only
  })

  it('includes an event exactly at `now` (window is closed at the end)', () => {
    expect(sumTokensInWindow(events, 3000, 100)).toBe(30)
  })

  it('sums zero for an empty event log', () => {
    expect(sumTokensInWindow([], 3000, FIVE_HOUR_MS)).toBe(0)
  })

  it('excludes events entirely outside the window', () => {
    expect(sumTokensInWindow(events, 100_000, 10)).toBe(0)
  })
})

describe('isIdleFallbackDue', () => {
  it('is false just under the threshold', () => {
    expect(
      isIdleFallbackDue(1000, 1000 + IDLE_FALLBACK_THRESHOLD_MS - 1, IDLE_FALLBACK_THRESHOLD_MS)
    ).toBe(false)
  })

  it('is true exactly at the threshold (inclusive boundary)', () => {
    expect(
      isIdleFallbackDue(1000, 1000 + IDLE_FALLBACK_THRESHOLD_MS, IDLE_FALLBACK_THRESHOLD_MS)
    ).toBe(true)
  })

  it('is true well past the threshold', () => {
    expect(isIdleFallbackDue(0, 10 * IDLE_FALLBACK_THRESHOLD_MS, IDLE_FALLBACK_THRESHOLD_MS)).toBe(
      true
    )
  })
})

describe('deriveUsageDisplay', () => {
  const planLimits: PlanLimitSettings = {
    preset: 'pro',
    customFiveHourTokens: null,
    customWeeklyTokens: null
  }

  it('uses measured rate_limits values (100 − used_percentage, resetsAt passthrough) when present', () => {
    const display = deriveUsageDisplay({
      rateLimits: {
        fiveHour: { usedPercentage: 12, resetsAt: 5_000 },
        sevenDay: { usedPercentage: 47, resetsAt: 9_000 }
      },
      localEstimate: { fiveHourTokens: 0, weeklyTokens: 0 },
      planLimits
    })
    expect(display.fiveHour).toEqual({
      source: 'measured',
      usedPercentage: 12,
      remainingPercentage: 88,
      resetsAtMs: 5_000
    })
    expect(display.weekly).toEqual({
      source: 'measured',
      usedPercentage: 47,
      remainingPercentage: 53,
      resetsAtMs: 9_000
    })
  })

  it('falls back to the local-token estimate when rate_limits is entirely null (spec §4.5)', () => {
    const display = deriveUsageDisplay({
      rateLimits: null,
      localEstimate: { fiveHourTokens: 500_000, weeklyTokens: 3_500_000 },
      planLimits // pro: 1,000,000 / 7,000,000
    })
    expect(display.fiveHour).toMatchObject({ source: 'estimated', usedPercentage: 50 })
    expect(display.weekly).toMatchObject({ source: 'estimated', usedPercentage: 50 })
    expect(display.fiveHour.resetsAtMs).toBeNull()
  })

  it('falls back to the estimate when both windows have a null used_percentage', () => {
    const display = deriveUsageDisplay({
      rateLimits: { fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: null },
      localEstimate: { fiveHourTokens: 100_000, weeklyTokens: 100_000 },
      planLimits
    })
    expect(display.fiveHour.source).toBe('estimated')
    expect(display.weekly.source).toBe('estimated')
  })

  it('derives each window independently when only one has a measured value', () => {
    const display = deriveUsageDisplay({
      rateLimits: { fiveHour: { usedPercentage: 30, resetsAt: 1 }, sevenDay: null },
      localEstimate: { fiveHourTokens: 0, weeklyTokens: 700_000 },
      planLimits // weekly pro limit 7,000,000 -> 700,000/7,000,000 = 10%
    })
    expect(display.fiveHour).toMatchObject({ source: 'measured', usedPercentage: 30 })
    expect(display.weekly).toMatchObject({ source: 'estimated', usedPercentage: 10 })
  })
})

describe('isEstimatedDisplay', () => {
  it('is false when both windows are measured', () => {
    const display = deriveUsageDisplay({
      rateLimits: {
        fiveHour: { usedPercentage: 1, resetsAt: null },
        sevenDay: { usedPercentage: 1, resetsAt: null }
      },
      localEstimate: { fiveHourTokens: 0, weeklyTokens: 0 },
      planLimits: { preset: 'pro', customFiveHourTokens: null, customWeeklyTokens: null }
    })
    expect(isEstimatedDisplay(display)).toBe(false)
  })

  it('is true when at least one window is estimated', () => {
    const display = deriveUsageDisplay({
      rateLimits: null,
      localEstimate: { fiveHourTokens: 0, weeklyTokens: 0 },
      planLimits: { preset: 'pro', customFiveHourTokens: null, customWeeklyTokens: null }
    })
    expect(isEstimatedDisplay(display)).toBe(true)
  })

  // M3 FIX (minor #4): no account available in this environment has ever produced a captured statusLine
  // payload with an empty/absent `rate_limits` (see usage.ts's `isEstimatedDisplay` doc comment and
  // statusline.ts's header comment for the live samples that *were* captured, both non-empty), so the
  // AC #6 estimated-fallback path cannot be exercised with a real capture. The three field-absence shapes
  // that would trigger it are exercised directly here instead, asserting both the "推定" badge condition
  // (`isEstimatedDisplay === true`) and that the estimated side's value is actually computed from the
  // local token estimate (not left at some default/zero).
  const fieldAbsencePlanLimits: PlanLimitSettings = {
    preset: 'pro', // 5h: 1,000,000 tokens / weekly: 7,000,000 tokens
    customFiveHourTokens: null,
    customWeeklyTokens: null
  }

  it('rate_limits entirely absent: both windows fall back to the local estimate', () => {
    const display = deriveUsageDisplay({
      rateLimits: null,
      localEstimate: { fiveHourTokens: 250_000, weeklyTokens: 700_000 },
      planLimits: fieldAbsencePlanLimits
    })
    expect(isEstimatedDisplay(display)).toBe(true)
    expect(display.fiveHour).toMatchObject({
      source: 'estimated',
      usedPercentage: 25,
      resetsAtMs: null
    })
    expect(display.weekly).toMatchObject({
      source: 'estimated',
      usedPercentage: 10,
      resetsAtMs: null
    })
  })

  it('only one window entirely absent: just that window falls back to the estimate', () => {
    const display = deriveUsageDisplay({
      rateLimits: { fiveHour: { usedPercentage: 40, resetsAt: 12_345 }, sevenDay: null },
      localEstimate: { fiveHourTokens: 0, weeklyTokens: 1_400_000 },
      planLimits: fieldAbsencePlanLimits
    })
    expect(isEstimatedDisplay(display)).toBe(true)
    expect(display.fiveHour).toMatchObject({ source: 'measured', usedPercentage: 40 })
    expect(display.weekly).toMatchObject({
      source: 'estimated',
      usedPercentage: 20,
      resetsAtMs: null
    })
  })

  it('a window present but its used_percentage absent: that window falls back to the estimate', () => {
    const display = deriveUsageDisplay({
      rateLimits: {
        fiveHour: { usedPercentage: null, resetsAt: 12_345 },
        sevenDay: { usedPercentage: 60, resetsAt: 67_890 }
      },
      localEstimate: { fiveHourTokens: 500_000, weeklyTokens: 0 },
      planLimits: fieldAbsencePlanLimits
    })
    expect(isEstimatedDisplay(display)).toBe(true)
    expect(display.fiveHour).toMatchObject({
      source: 'estimated',
      usedPercentage: 50,
      resetsAtMs: null
    })
    expect(display.weekly).toMatchObject({ source: 'measured', usedPercentage: 60 })
  })
})

// sanity: the two window constants match their names (regression guard for typos/unit mixups)
describe('window constants', () => {
  it('FIVE_HOUR_MS is 5 hours in milliseconds', () => {
    expect(FIVE_HOUR_MS).toBe(5 * 60 * 60 * 1000)
  })

  it('SEVEN_DAY_MS is 7 days in milliseconds', () => {
    expect(SEVEN_DAY_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})
