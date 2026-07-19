import { describe, expect, it } from 'vitest'
import { LAUNCH_QUIET_MS, LAUNCH_TIMEOUT_MS, evaluateLaunchReadiness } from './launchReadiness'

describe('evaluateLaunchReadiness (TD-1)', () => {
  it('is not ready before any signal and before the timeout', () => {
    const result = evaluateLaunchReadiness({
      spawnedAtMs: 0,
      statusLineEventAtMs: null,
      lastPtyOutputAtMs: null,
      nowMs: 100
    })
    expect(result).toEqual({ ready: false })
  })

  it('is ready via statusline the instant the first statusLine event is observed', () => {
    const result = evaluateLaunchReadiness({
      spawnedAtMs: 0,
      statusLineEventAtMs: 50,
      lastPtyOutputAtMs: null,
      nowMs: 50
    })
    expect(result).toEqual({ ready: true, reason: 'statusline' })
  })

  it('statusline takes precedence even if the quiet window has also elapsed', () => {
    const result = evaluateLaunchReadiness({
      spawnedAtMs: 0,
      statusLineEventAtMs: 900,
      lastPtyOutputAtMs: 100,
      nowMs: 900
    })
    expect(result).toEqual({ ready: true, reason: 'statusline' })
  })

  it('is not ready one ms before the 700ms quiet threshold (boundary)', () => {
    const result = evaluateLaunchReadiness({
      spawnedAtMs: 0,
      statusLineEventAtMs: null,
      lastPtyOutputAtMs: 100,
      nowMs: 100 + LAUNCH_QUIET_MS - 1
    })
    expect(result).toEqual({ ready: false })
  })

  it('is ready via quiet exactly at the 700ms quiet threshold (boundary)', () => {
    const result = evaluateLaunchReadiness({
      spawnedAtMs: 0,
      statusLineEventAtMs: null,
      lastPtyOutputAtMs: 100,
      nowMs: 100 + LAUNCH_QUIET_MS
    })
    expect(result).toEqual({ ready: true, reason: 'quiet' })
  })

  it('never fires the quiet fallback before any pty output has been observed', () => {
    const result = evaluateLaunchReadiness({
      spawnedAtMs: 0,
      statusLineEventAtMs: null,
      lastPtyOutputAtMs: null,
      // Far past the 700ms quiet window (which requires output to have occurred at all) but still
      // well below the 10s hard cap, so the only way this could wrongly read "ready" is a
      // quiet-fallback bug that doesn't guard on lastPtyOutputAtMs !== null.
      nowMs: LAUNCH_QUIET_MS * 5
    })
    expect(result).toEqual({ ready: false })
  })

  it('is not ready one ms before the 10s hard timeout (boundary)', () => {
    const result = evaluateLaunchReadiness({
      spawnedAtMs: 0,
      statusLineEventAtMs: null,
      lastPtyOutputAtMs: null,
      nowMs: LAUNCH_TIMEOUT_MS - 1
    })
    expect(result).toEqual({ ready: false })
  })

  it('is ready via timeout exactly at the 10s hard cap regardless of other signals (boundary)', () => {
    const result = evaluateLaunchReadiness({
      spawnedAtMs: 0,
      statusLineEventAtMs: null,
      lastPtyOutputAtMs: null,
      nowMs: LAUNCH_TIMEOUT_MS
    })
    expect(result).toEqual({ ready: true, reason: 'timeout' })
  })

  it('the hard timeout wins over quiet when both would be true (timeout checked first)', () => {
    const result = evaluateLaunchReadiness({
      spawnedAtMs: 0,
      statusLineEventAtMs: null,
      lastPtyOutputAtMs: 9000,
      nowMs: LAUNCH_TIMEOUT_MS
    })
    expect(result).toEqual({ ready: true, reason: 'timeout' })
  })

  it('honors injected custom quietMs/timeoutMs overrides', () => {
    const notReady = evaluateLaunchReadiness({
      spawnedAtMs: 0,
      statusLineEventAtMs: null,
      lastPtyOutputAtMs: 0,
      nowMs: 50,
      quietMs: 100,
      timeoutMs: 1000
    })
    expect(notReady).toEqual({ ready: false })

    const readyByQuiet = evaluateLaunchReadiness({
      spawnedAtMs: 0,
      statusLineEventAtMs: null,
      lastPtyOutputAtMs: 0,
      nowMs: 100,
      quietMs: 100,
      timeoutMs: 1000
    })
    expect(readyByQuiet).toEqual({ ready: true, reason: 'quiet' })
  })
})
