// Behavioral tests for LaunchReadinessWatcher (TD-1): real-timer plumbing driving the pure
// evaluateLaunchReadiness decision, using vitest fake timers so 700ms/10s waits run instantly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LaunchReadinessWatcher } from './launchReadinessWatcher'

describe('LaunchReadinessWatcher (TD-1)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires via statusline immediately on the first statusLine event, without waiting for any timer', () => {
    const onReady = vi.fn()
    const watcher = new LaunchReadinessWatcher({ onReady })
    watcher.onStatusLineEvent()

    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith('statusline')
  })

  it('fires via quiet after 700ms of no further pty output', () => {
    const onReady = vi.fn()
    const watcher = new LaunchReadinessWatcher({ onReady })

    watcher.onPtyOutput()
    expect(onReady).not.toHaveBeenCalled()
    vi.advanceTimersByTime(699)
    expect(onReady).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith('quiet')
  })

  it('resets the 700ms quiet window on each new pty output chunk', () => {
    const onReady = vi.fn()
    const watcher = new LaunchReadinessWatcher({ onReady })

    watcher.onPtyOutput()
    vi.advanceTimersByTime(500)
    watcher.onPtyOutput() // resets the quiet clock
    vi.advanceTimersByTime(500)
    expect(onReady).not.toHaveBeenCalled() // only 500ms quiet since the reset
    vi.advanceTimersByTime(200)
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith('quiet')
  })

  it('fires via timeout at the 10s hard cap even with no statusLine event and no pty output', () => {
    const onReady = vi.fn()
    new LaunchReadinessWatcher({ onReady })

    vi.advanceTimersByTime(9999)
    expect(onReady).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith('timeout')
  })

  it('fires only once even if a statusLine event arrives after the hard timeout already fired', () => {
    const onReady = vi.fn()
    const watcher = new LaunchReadinessWatcher({ onReady })

    vi.advanceTimersByTime(10_000)
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith('timeout')

    watcher.onStatusLineEvent()
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('dispose() cancels pending timers and suppresses any further onReady call', () => {
    const onReady = vi.fn()
    const watcher = new LaunchReadinessWatcher({ onReady })

    watcher.onPtyOutput()
    watcher.dispose()
    vi.advanceTimersByTime(10_000)

    expect(onReady).not.toHaveBeenCalled()
  })

  it('respects injected quietMs/timeoutMs overrides', () => {
    const onReady = vi.fn()
    const watcher = new LaunchReadinessWatcher({ onReady, quietMs: 50, timeoutMs: 200 })

    watcher.onPtyOutput()
    vi.advanceTimersByTime(50)
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith('quiet')
  })
})
