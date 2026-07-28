// FIX M2 (review iter1): pins RepoSyncLock's atomicity and Windows path-normalized key comparison.
import { describe, expect, it } from 'vitest'
import { RepoSyncLock } from './repoSyncLock'

/** A manually-resolvable Promise<void>, as a plain object (not a `let` reassigned from inside the
 * executor closure) -- TypeScript's control-flow analysis narrows a closure-reassigned `let` to `never`
 * at the read site in this exact shape (reproduced in isolation; a plain object property sidesteps it
 * entirely). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  const box: { resolve: (() => void) | null } = { resolve: null }
  const promise = new Promise<void>((resolve) => {
    box.resolve = resolve
  })
  return {
    promise,
    resolve: () => box.resolve?.()
  }
}

describe('RepoSyncLock', () => {
  it('holderPane is null when nothing holds the lock', () => {
    const lock = new RepoSyncLock()
    expect(lock.holderPane('C:\\repo')).toBeNull()
  })

  it('reports the holding pane while withLock is in flight, and null again once it settles', async () => {
    const lock = new RepoSyncLock()
    const { promise, resolve } = deferred()
    const inFlight = lock.withLock('C:\\repo', 1, () => promise)

    expect(lock.holderPane('C:\\repo')).toBe(1)

    resolve()
    await inFlight
    expect(lock.holderPane('C:\\repo')).toBeNull()
  })

  it('releases the lock even when fn throws', async () => {
    const lock = new RepoSyncLock()
    await expect(
      lock.withLock('C:\\repo', 0, () => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom')
    expect(lock.holderPane('C:\\repo')).toBeNull()
  })

  it('normalizes repo-root comparison (Windows separator/case, R-6-style)', async () => {
    const lock = new RepoSyncLock()
    const { promise, resolve } = deferred()
    const inFlight = lock.withLock('C:\\repo', 2, () => promise)

    expect(lock.holderPane('C:/repo')).toBe(2)
    expect(lock.holderPane('C:\\REPO')).toBe(2)

    resolve()
    await inFlight
  })

  it('does not confuse two genuinely different repo roots', async () => {
    const lock = new RepoSyncLock()
    const { promise, resolve } = deferred()
    const inFlight = lock.withLock('C:\\repo-a', 0, () => promise)

    expect(lock.holderPane('C:\\repo-b')).toBeNull()

    resolve()
    await inFlight
  })

  it("resolves with fn's return value", async () => {
    const lock = new RepoSyncLock()
    const result = await lock.withLock('C:\\repo', 0, async () => 42)
    expect(result).toBe(42)
  })

  it('allows re-acquiring the same repo root once the previous holder released it', async () => {
    const lock = new RepoSyncLock()
    await lock.withLock('C:\\repo', 0, async () => undefined)
    expect(lock.holderPane('C:\\repo')).toBeNull()

    const { promise, resolve } = deferred()
    const inFlight = lock.withLock('C:\\repo', 3, () => promise)
    expect(lock.holderPane('C:\\repo')).toBe(3)
    resolve()
    await inFlight
  })
})
