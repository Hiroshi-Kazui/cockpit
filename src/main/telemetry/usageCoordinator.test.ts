// Behavioral tests for UsageCoordinator: per-pane context-gauge push on statusLine messages, app-wide
// measured/estimated rate-limit display recompute+push, local-token windowed estimate from JSONL
// entries, and idle-activity notification (spec §4.5, M3 AC #1/#3/#4/#6).
import { describe, expect, it, vi } from 'vitest'
import { UsageCoordinator } from './usageCoordinator'
import type { PaneIndex, UsageDisplay } from '../../shared/ipc'
import type { ContextGaugeColor, PlanLimitSettings } from '../../shared/usage'

interface SetupOptions {
  planLimits?: PlanLimitSettings
  clock?: () => number
}

function setup(options: SetupOptions = {}) {
  const paneContextUsageCalls: Array<{
    pane: PaneIndex
    usedPercentage: number
    color: ContextGaugeColor
  }> = []
  const usageDisplays: UsageDisplay[] = []
  const noteActivity = vi.fn()
  const planLimits: PlanLimitSettings = options.planLimits ?? {
    preset: 'pro',
    customFiveHourTokens: null,
    customWeeklyTokens: null
  }
  const coordinator = new UsageCoordinator({
    onPaneContextUsage: (pane, usedPercentage, color) => {
      paneContextUsageCalls.push({ pane, usedPercentage, color })
    },
    onUsageDisplay: (display) => usageDisplays.push(display),
    getPlanLimitSettings: () => planLimits,
    noteActivity,
    now: options.clock
  })
  return { coordinator, paneContextUsageCalls, usageDisplays, noteActivity }
}

describe('UsageCoordinator.onRawMessage', () => {
  it('pushes a context-gauge reading with the correct color when contextUsedPercentage is present', () => {
    const { coordinator, paneContextUsageCalls } = setup()
    coordinator.onRawMessage({ pane: 1, context: { used_percentage: 72 } })

    expect(paneContextUsageCalls).toEqual([{ pane: 1, usedPercentage: 72, color: 'orange' }])
  })

  it('does not push a context-gauge reading when contextUsedPercentage is absent', () => {
    const { coordinator, paneContextUsageCalls } = setup()
    coordinator.onRawMessage({ pane: 1, session_id: 's1' })

    expect(paneContextUsageCalls).toEqual([])
  })

  it('notifies activity for any accepted message, even one with only a pane', () => {
    const { coordinator, noteActivity } = setup()
    coordinator.onRawMessage({ pane: 0 })

    expect(noteActivity).toHaveBeenCalledTimes(1)
  })

  it('does not notify activity or push anything for a message with an invalid/out-of-range pane', () => {
    const { coordinator, noteActivity, paneContextUsageCalls, usageDisplays } = setup()
    coordinator.onRawMessage({ pane: 9, context: { used_percentage: 50 } })

    expect(noteActivity).not.toHaveBeenCalled()
    expect(paneContextUsageCalls).toEqual([])
    expect(usageDisplays).toEqual([])
  })

  it('does not throw on a non-object payload (spec §7 tolerance)', () => {
    const { coordinator } = setup()
    expect(() => coordinator.onRawMessage(null)).not.toThrow()
    expect(() => coordinator.onRawMessage('garbage')).not.toThrow()
  })

  it('pushes a measured usage display when rate_limits is present', () => {
    // resets_at values are epoch milliseconds (>= 10^12) here, not arbitrary small placeholders --
    // shared/statusline.ts's normalizeResetsAt (M3 FIX iteration 2) treats numbers below 10^12 as
    // epoch *seconds* and rescales them, so a small placeholder like `111` would no longer pass through
    // unchanged.
    const { coordinator, usageDisplays } = setup()
    coordinator.onRawMessage({
      pane: 0,
      rate_limits: {
        five_hour: { used_percentage: 20, resets_at: 1_700_000_000_111 },
        seven_day: { used_percentage: 40, resets_at: 1_700_000_000_222 }
      }
    })

    expect(usageDisplays).toHaveLength(1)
    expect(usageDisplays[0]).toMatchObject({
      fiveHour: {
        source: 'measured',
        usedPercentage: 20,
        remainingPercentage: 80,
        resetsAtMs: 1_700_000_000_111
      },
      weekly: {
        source: 'measured',
        usedPercentage: 40,
        remainingPercentage: 60,
        resetsAtMs: 1_700_000_000_222
      }
    })
  })

  it('does not push a usage display when rate_limits is absent (no change to report)', () => {
    const { coordinator, usageDisplays } = setup()
    coordinator.onRawMessage({ pane: 0, context: { used_percentage: 10 } })

    expect(usageDisplays).toEqual([])
  })
})

describe('UsageCoordinator.onJsonlEntries', () => {
  it('feeds the local-token window and pushes an estimated display when rate_limits is unknown', () => {
    const { coordinator, usageDisplays, noteActivity } = setup({ clock: () => 1000 })
    coordinator.onJsonlEntries([
      {
        timestampMs: 500,
        model: 'claude-x',
        usage: {
          inputTokens: 400_000,
          outputTokens: 100_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0
        },
        userText: null,
        isUserTurnMissingHumanOrigin: false
      }
    ])

    expect(noteActivity).toHaveBeenCalledTimes(1)
    expect(usageDisplays).toHaveLength(1)
    // pro preset 5h limit = 1,000,000 tokens; 500,000 used -> 50%
    expect(usageDisplays[0].fiveHour).toMatchObject({ source: 'estimated', usedPercentage: 50 })
  })

  it('ignores entries with no usage or no timestamp (nothing to aggregate)', () => {
    const { coordinator, usageDisplays } = setup({ clock: () => 1000 })
    coordinator.onJsonlEntries([
      {
        timestampMs: null,
        model: null,
        usage: { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        userText: null,
        isUserTurnMissingHumanOrigin: false
      },
      {
        timestampMs: 500,
        model: null,
        usage: null,
        userText: null,
        isUserTurnMissingHumanOrigin: false
      }
    ])

    expect(usageDisplays[0].fiveHour).toMatchObject({ source: 'estimated', usedPercentage: 0 })
  })

  it('does nothing for an empty entries array (no spurious activity/push)', () => {
    const { coordinator, usageDisplays, noteActivity } = setup()
    coordinator.onJsonlEntries([])

    expect(noteActivity).not.toHaveBeenCalled()
    expect(usageDisplays).toEqual([])
  })

  it('prunes token events older than 7 days out of the estimate window', () => {
    const clock = 8 * 24 * 60 * 60 * 1000 // now = 8 days (in ms) after epoch 0
    const { coordinator, usageDisplays } = setup({ clock: () => clock })
    // this entry is 8 days old relative to `clock` -- outside the 7-day weekly window
    coordinator.onJsonlEntries([
      {
        timestampMs: 0,
        model: null,
        usage: {
          inputTokens: 7_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0
        },
        userText: null,
        isUserTurnMissingHumanOrigin: false
      }
    ])
    expect(usageDisplays[usageDisplays.length - 1].weekly).toMatchObject({
      source: 'estimated',
      usedPercentage: 0
    })
  })
})

describe('UsageCoordinator.onFallbackFetched', () => {
  it('adopts a successful fallback fetch result and pushes a measured display', () => {
    const { coordinator, usageDisplays } = setup()
    coordinator.onFallbackFetched({
      fiveHour: { usedPercentage: 33, resetsAt: 1 },
      sevenDay: { usedPercentage: 66, resetsAt: 2 }
    })

    expect(usageDisplays).toHaveLength(1)
    expect(usageDisplays[0].fiveHour).toMatchObject({ source: 'measured', usedPercentage: 33 })
  })

  it('leaves the display unchanged (no push) when the fetch produced nothing usable (null)', () => {
    const { coordinator, usageDisplays } = setup()
    coordinator.onFallbackFetched(null)

    expect(usageDisplays).toEqual([])
  })
})

describe('UsageCoordinator.refreshDisplay', () => {
  it('recomputes and pushes using the latest getPlanLimitSettings() value (settings-change refresh)', () => {
    let planLimits: PlanLimitSettings = {
      preset: 'pro',
      customFiveHourTokens: null,
      customWeeklyTokens: null
    }
    const usageDisplays: UsageDisplay[] = []
    const coordinator = new UsageCoordinator({
      onPaneContextUsage: () => {},
      onUsageDisplay: (d) => usageDisplays.push(d),
      getPlanLimitSettings: () => planLimits,
      noteActivity: () => {},
      now: () => 1000
    })
    coordinator.onJsonlEntries([
      {
        timestampMs: 500,
        model: null,
        usage: {
          inputTokens: 500_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0
        },
        userText: null,
        isUserTurnMissingHumanOrigin: false
      }
    ])
    expect(usageDisplays[0].fiveHour).toMatchObject({ usedPercentage: 50 }) // 500k / 1,000,000 (pro)

    planLimits = { preset: 'max20x', customFiveHourTokens: null, customWeeklyTokens: null }
    coordinator.refreshDisplay()
    expect(usageDisplays[1].fiveHour).toMatchObject({ usedPercentage: 2.5 }) // 500k / 20,000,000
  })
})
