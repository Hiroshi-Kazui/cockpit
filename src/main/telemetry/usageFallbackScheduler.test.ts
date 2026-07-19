// Behavioral tests for UsageFallbackScheduler's idle-triggered single-shot fetch (spec §4.5, AC #5):
// exactly one fetch per idle period, no re-firing while idle continues without new activity, and a
// fresh noteActivity() after a fetch schedules exactly one more single-shot attempt.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageFallbackScheduler } from './usageFallbackScheduler'
import { IDLE_FALLBACK_THRESHOLD_MS } from '../../shared/usage'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('UsageFallbackScheduler', () => {
  it('does not fetch before the idle threshold elapses', () => {
    const fetchFallback = vi.fn(async () => {})
    // Constructed purely for its side effect (arming the timer); no assertions need the instance itself.
    new UsageFallbackScheduler({ fetchFallback })

    vi.advanceTimersByTime(IDLE_FALLBACK_THRESHOLD_MS - 1)
    expect(fetchFallback).not.toHaveBeenCalled()
  })

  it('fetches exactly once after the idle threshold elapses with no activity', () => {
    const fetchFallback = vi.fn(async () => {})
    new UsageFallbackScheduler({ fetchFallback })

    vi.advanceTimersByTime(IDLE_FALLBACK_THRESHOLD_MS)
    expect(fetchFallback).toHaveBeenCalledTimes(1)
  })

  it('does NOT keep re-fetching every idleThresholdMs while idle continues uninterrupted (no periodic polling)', () => {
    const fetchFallback = vi.fn(async () => {})
    new UsageFallbackScheduler({ fetchFallback })

    vi.advanceTimersByTime(IDLE_FALLBACK_THRESHOLD_MS) // first fetch fires
    vi.advanceTimersByTime(IDLE_FALLBACK_THRESHOLD_MS * 5) // stay idle for many more periods
    expect(fetchFallback).toHaveBeenCalledTimes(1)
  })

  it('a noteActivity() call resets the idle clock, delaying the fetch', () => {
    const fetchFallback = vi.fn(async () => {})
    const scheduler = new UsageFallbackScheduler({ fetchFallback })

    vi.advanceTimersByTime(IDLE_FALLBACK_THRESHOLD_MS - 1000)
    scheduler.noteActivity()
    vi.advanceTimersByTime(IDLE_FALLBACK_THRESHOLD_MS - 1000)
    expect(fetchFallback).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    expect(fetchFallback).toHaveBeenCalledTimes(1)
  })

  it('a fresh noteActivity() after a fetch fired schedules exactly one more single-shot attempt', () => {
    const fetchFallback = vi.fn(async () => {})
    const scheduler = new UsageFallbackScheduler({ fetchFallback })

    vi.advanceTimersByTime(IDLE_FALLBACK_THRESHOLD_MS)
    expect(fetchFallback).toHaveBeenCalledTimes(1)

    scheduler.noteActivity()
    vi.advanceTimersByTime(IDLE_FALLBACK_THRESHOLD_MS)
    expect(fetchFallback).toHaveBeenCalledTimes(2)
  })

  it('stop() cancels a pending timer so no fetch fires afterward', () => {
    const fetchFallback = vi.fn(async () => {})
    const scheduler = new UsageFallbackScheduler({ fetchFallback })

    scheduler.stop()
    vi.advanceTimersByTime(IDLE_FALLBACK_THRESHOLD_MS * 2)
    expect(fetchFallback).not.toHaveBeenCalled()
  })

  it('honors a custom idleThresholdMs', () => {
    const fetchFallback = vi.fn(async () => {})
    new UsageFallbackScheduler({ fetchFallback, idleThresholdMs: 1000 })

    vi.advanceTimersByTime(999)
    expect(fetchFallback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fetchFallback).toHaveBeenCalledTimes(1)
  })
})
