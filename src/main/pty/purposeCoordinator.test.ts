// Behavioral tests for PurposeCoordinator (spec §4.2/§4.6, TD-1/TD-7) using fully in-memory fakes for
// every side effect -- no real pty/timers/SQLite, matching sessionCoordinator.test.ts's style.
import { describe, expect, it, vi } from 'vitest'
import {
  PurposeCoordinator,
  type LaunchWatcherLike,
  type PurposeCoordinatorDeps
} from './purposeCoordinator'
import type { PurposeSummary } from '../../shared/ipc'

function makePurpose(overrides: Partial<PurposeSummary> = {}): PurposeSummary {
  return {
    id: 'p1',
    pane: 0,
    text: 'READMEにセットアップ手順を追記して',
    title: null,
    status: 'active',
    createdAt: 1000,
    completedAt: null,
    ...overrides
  }
}

interface Harness {
  coordinator: PurposeCoordinator
  writes: Array<{ pane: number; data: string }>
  purposeUpdates: PurposeSummary[]
  spawnCalls: Array<{ pane: number; cwd: string; extraArgs: readonly string[] | undefined }>
  paneLaunchedCalls: Array<{ pane: number; cwd: string; origin: 'dialog' | 'restart' }>
  watcherCreated: boolean
  watcher: {
    onReady: ((reason: 'statusline' | 'quiet' | 'timeout') => void) | null
    disposed: boolean
  }
  purposesById: Map<string, PurposeSummary>
  sessionsBackfilledPurpose: Array<{ purposeId: string; text: string }>
  sessionsBackfilledTitle: Array<{ purposeId: string; title: string }>
  resyncedPurposeIds: string[]
}

function setup(overrides: Partial<PurposeCoordinatorDeps> = {}): Harness {
  const writes: Array<{ pane: number; data: string }> = []
  const purposeUpdates: PurposeSummary[] = []
  const spawnCalls: Array<{ pane: number; cwd: string; extraArgs: readonly string[] | undefined }> =
    []
  const paneLaunchedCalls: Array<{ pane: number; cwd: string; origin: 'dialog' | 'restart' }> = []
  const purposesById = new Map<string, PurposeSummary>()
  const sessionsBackfilledPurpose: Array<{ purposeId: string; text: string }> = []
  const sessionsBackfilledTitle: Array<{ purposeId: string; title: string }> = []
  const resyncedPurposeIds: string[] = []
  let activePurpose: PurposeSummary | null = null
  let watcherCreated = false
  const watcher: {
    onReady: ((reason: 'statusline' | 'quiet' | 'timeout') => void) | null
    disposed: boolean
  } = { onReady: null, disposed: false }

  const deps: PurposeCoordinatorDeps = {
    spawnPty: (pane, cwd, extraArgs) => {
      spawnCalls.push({ pane, cwd, extraArgs })
      return { pid: 4242 }
    },
    writeToPty: (pane, data) => {
      writes.push({ pane, data })
    },
    onPaneLaunched: (pane, cwd, origin) => {
      paneLaunchedCalls.push({ pane, cwd, origin })
    },
    createPurpose: (pane, text) => {
      const purpose = makePurpose({ id: `p-${purposesById.size + 1}`, pane, text })
      purposesById.set(purpose.id, purpose)
      activePurpose = purpose
      return purpose
    },
    getActivePurposeForPane: () => activePurpose,
    updatePurposeTitle: (id, title) => {
      const existing = purposesById.get(id)
      if (!existing) return null
      const updated = { ...existing, title }
      purposesById.set(id, updated)
      if (activePurpose?.id === id) activePurpose = updated
      return updated
    },
    updatePurposeText: (id, text) => {
      const existing = purposesById.get(id)
      if (!existing) return null
      const updated = { ...existing, text }
      purposesById.set(id, updated)
      if (activePurpose?.id === id) activePurpose = updated
      return updated
    },
    backfillSessionsPurposeText: (purposeId, text) => {
      sessionsBackfilledPurpose.push({ purposeId, text })
    },
    backfillSessionsTitle: (purposeId, title) => {
      sessionsBackfilledTitle.push({ purposeId, title })
    },
    resyncSessionsForPurpose: (purposeId) => {
      resyncedPurposeIds.push(purposeId)
    },
    completePurpose: (id) => {
      const existing = purposesById.get(id)
      if (!existing) return null
      const updated = { ...existing, status: 'completed' as const, completedAt: 9999 }
      purposesById.set(id, updated)
      if (activePurpose?.id === id) activePurpose = null
      return updated
    },
    generateTitle: () => Promise.resolve('Generated Title'),
    onPurposeUpdated: (summary) => {
      purposeUpdates.push(summary)
    },
    createWatcher: (onReady) => {
      watcherCreated = true
      watcher.onReady = onReady
      const fake: LaunchWatcherLike = {
        onStatusLineEvent: () => {},
        onPtyOutput: () => {},
        dispose: () => {
          watcher.disposed = true
        }
      }
      return fake
    },
    ...overrides
  }

  return {
    coordinator: new PurposeCoordinator(deps),
    writes,
    purposeUpdates,
    spawnCalls,
    paneLaunchedCalls,
    get watcherCreated() {
      return watcherCreated
    },
    watcher,
    purposesById,
    sessionsBackfilledPurpose,
    sessionsBackfilledTitle,
    resyncedPurposeIds
  }
}

describe('PurposeCoordinator.startNewSession', () => {
  it('spawns the pty, creates the purpose (origin=dialog), pushes it immediately, and arms a launch watcher', () => {
    const h = setup()
    const result = h.coordinator.startNewSession(0, 'C:\\repo', 'fix the bug')

    expect(result.pid).toBe(4242)
    expect(h.spawnCalls).toEqual([{ pane: 0, cwd: 'C:\\repo', extraArgs: undefined }])
    expect(h.paneLaunchedCalls).toEqual([{ pane: 0, cwd: 'C:\\repo', origin: 'dialog' }])
    expect(h.purposeUpdates[0]).toMatchObject({
      text: 'fix the bug',
      status: 'active',
      title: null
    })
    expect(result.purposeId).toBe(h.purposeUpdates[0].id)
  })

  it('does not create a purpose row when spawnPty throws (no orphan purpose on resolution failure)', () => {
    const h = setup({
      spawnPty: () => {
        throw new Error('claude not found')
      }
    })

    expect(() => h.coordinator.startNewSession(0, 'C:\\repo', 'fix the bug')).toThrow(
      'claude not found'
    )
    expect(h.purposeUpdates).toEqual([])
  })

  it('sends the purpose text + \\r to the pty once the launch watcher reports ready', () => {
    const h = setup()
    h.coordinator.startNewSession(0, 'C:\\repo', 'fix the bug')

    expect(h.writes).toEqual([])
    h.watcher.onReady?.('statusline')

    expect(h.writes).toEqual([{ pane: 0, data: 'fix the bug\r' }])
  })

  it('collapses internal newlines in the purpose text to spaces before sending (FIX #6: multi-line paste must not look like multiple Enter presses to the TUI)', () => {
    const h = setup()
    h.coordinator.startNewSession(0, 'C:\\repo', 'line one\nline two\nline three')

    h.watcher.onReady?.('statusline')

    expect(h.writes).toEqual([{ pane: 0, data: 'line one line two line three\r' }])
  })

  it('does not throw and logs when writeToPty fails after the watcher fires (pty already exited)', () => {
    const h = setup({
      writeToPty: () => {
        throw new Error('No claude process is running in pane 0')
      }
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    h.coordinator.startNewSession(0, 'C:\\repo', 'fix the bug')

    expect(() => h.watcher.onReady?.('timeout')).not.toThrow()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('applies the generated title asynchronously without blocking startNewSession (AC: non-blocking)', async () => {
    let resolveTitle: (title: string) => void = () => {}
    const h = setup({
      generateTitle: () =>
        new Promise<string>((resolve) => {
          resolveTitle = resolve
        })
    })

    const result = h.coordinator.startNewSession(0, 'C:\\repo', 'fix the bug')
    expect(result.purposeId).toBeDefined() // returned synchronously, generateTitle still pending

    resolveTitle('Bug Fix')
    await new Promise((r) => setTimeout(r, 0))

    const finalUpdate = h.purposeUpdates.at(-1)
    expect(finalUpdate?.title).toBe('Bug Fix')
    expect(h.sessionsBackfilledTitle).toEqual([{ purposeId: finalUpdate?.id, title: 'Bug Fix' }])
    // FIX (major #1, eventual-consistency): metadata.json resync must be re-triggered once the async
    // title lands, not just once at purpose creation.
    expect(h.resyncedPurposeIds).toContain(finalUpdate?.id)
  })

  it('trims the purpose text before storing it, and before sending it as the initial prompt', () => {
    const h = setup()
    h.coordinator.startNewSession(0, 'C:\\repo', '  fix the bug  ')

    expect(h.purposeUpdates[0].text).toBe('fix the bug')
    h.watcher.onReady?.('statusline')
    expect(h.writes).toEqual([{ pane: 0, data: 'fix the bug\r' }])
  })

  it('does NOT arm a launch watcher, send an initial prompt, or start title generation when purposeText is empty (spec §4.2 "目的テキストの入力は任意"/"目的が空で開始した場合")', () => {
    const h = setup()
    const result = h.coordinator.startNewSession(0, 'C:\\repo', '')

    expect(result.pid).toBe(4242)
    expect(h.purposeUpdates).toHaveLength(1)
    expect(h.purposeUpdates[0]).toMatchObject({ text: '', title: null, status: 'active' })
    expect(h.paneLaunchedCalls).toEqual([{ pane: 0, cwd: 'C:\\repo', origin: 'dialog' }])
    expect(h.watcherCreated).toBe(false)
    expect(h.writes).toEqual([])
  })

  it('treats whitespace-only purposeText the same as empty (no auto-send, no title generation)', () => {
    const h = setup()
    h.coordinator.startNewSession(0, 'C:\\repo', '   \n  ')

    expect(h.purposeUpdates[0]).toMatchObject({ text: '', title: null })
    expect(h.watcherCreated).toBe(false)
  })

  it('falls back to a truncated title and logs when title generation fails (AC: no silent failure)', async () => {
    const h = setup({ generateTitle: () => Promise.reject(new Error('claude -p timed out')) })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    h.coordinator.startNewSession(0, 'C:\\repo', 'a'.repeat(40))
    await new Promise((r) => setTimeout(r, 0))

    const finalUpdate = h.purposeUpdates.at(-1)
    expect(finalUpdate?.title).toBe('a'.repeat(20) + '…')
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('title'), expect.any(Error))
    // FIX (major #1, eventual-consistency): the fallback-title path must also resync, not just the
    // happy-path title generation.
    expect(h.resyncedPurposeIds).toContain(finalUpdate?.id)
    spy.mockRestore()
  })
})

describe('PurposeCoordinator.decidePurposeFromFirstMessage', () => {
  it('persists the text, backfills sessions, pushes the update, and generates a title (spec §4.2)', async () => {
    const h = setup()
    const { purposeId } = h.coordinator.startNewSession(0, 'C:\\repo', '') // empty start
    h.purposeUpdates.length = 0

    h.coordinator.decidePurposeFromFirstMessage(purposeId, 'fix the login bug')

    expect(h.purposeUpdates[0]).toMatchObject({ id: purposeId, text: 'fix the login bug' })
    expect(h.sessionsBackfilledPurpose).toEqual([{ purposeId, text: 'fix the login bug' }])
    // FIX (major #1, eventual-consistency): the metadata.json resync must fire right after the text
    // backfill lands, not only later once the title also resolves.
    expect(h.resyncedPurposeIds).toContain(purposeId)

    await new Promise((r) => setTimeout(r, 0))
    const finalUpdate = h.purposeUpdates.at(-1)
    expect(finalUpdate?.title).toBe('Generated Title')
    expect(h.sessionsBackfilledTitle).toEqual([{ purposeId, title: 'Generated Title' }])
    // resynced once for the text decision, once again for the title.
    expect(h.resyncedPurposeIds.filter((id) => id === purposeId)).toHaveLength(2)
  })

  it('does not send an initial prompt to the pty (the user already typed it themselves)', () => {
    const h = setup()
    const { purposeId } = h.coordinator.startNewSession(0, 'C:\\repo', '')

    h.coordinator.decidePurposeFromFirstMessage(purposeId, 'fix the login bug')

    expect(h.writes).toEqual([])
  })

  it('logs and does nothing when the purpose id no longer exists (AC: no silent failure)', () => {
    const h = setup()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    h.coordinator.decidePurposeFromFirstMessage('missing-purpose', 'fix the bug')

    expect(h.purposeUpdates).toEqual([])
    expect(h.sessionsBackfilledPurpose).toEqual([])
    expect(h.resyncedPurposeIds).toEqual([])
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('missing-purpose'))
    spy.mockRestore()
  })
})

describe('PurposeCoordinator.resumeSession', () => {
  it('throws when the pane has no active purpose', () => {
    const h = setup()
    expect(() => h.coordinator.resumeSession(0, 'C:\\repo')).toThrow(/no active purpose/)
  })

  it('spawns claude with --continue and origin=restart, sends no initial prompt', () => {
    const h = setup()
    h.coordinator.startNewSession(0, 'C:\\repo', 'fix the bug') // establishes an active purpose
    h.spawnCalls.length = 0
    h.paneLaunchedCalls.length = 0

    const result = h.coordinator.resumeSession(0, 'C:\\repo')

    expect(result.pid).toBe(4242)
    expect(h.spawnCalls).toEqual([{ pane: 0, cwd: 'C:\\repo', extraArgs: ['--continue'] }])
    expect(h.paneLaunchedCalls).toEqual([{ pane: 0, cwd: 'C:\\repo', origin: 'restart' }])
    expect(h.writes).toEqual([])
  })

  it('does not reset the pane launch lifecycle when spawnPty throws (FIX #7: spawn precedes onPaneLaunched, symmetric with startNewSession)', () => {
    let callCount = 0
    const h = setup({
      spawnPty: () => {
        callCount++
        if (callCount === 1) return { pid: 4242 } // startNewSession's own spawn, to establish an active purpose
        throw new Error('claude not found')
      }
    })
    h.coordinator.startNewSession(0, 'C:\\repo', 'fix the bug')
    h.paneLaunchedCalls.length = 0

    expect(() => h.coordinator.resumeSession(0, 'C:\\repo')).toThrow('claude not found')
    expect(h.paneLaunchedCalls).toEqual([])
  })
})

describe('PurposeCoordinator.completePurpose', () => {
  it('marks the purpose completed and pushes the update', () => {
    const h = setup()
    h.coordinator.startNewSession(0, 'C:\\repo', 'fix the bug')
    const purposeId = h.purposeUpdates[0].id

    const result = h.coordinator.completePurpose(purposeId)

    expect(result.status).toBe('completed')
    expect(h.purposeUpdates.at(-1)).toMatchObject({ status: 'completed' })
  })

  it('throws for an unknown purpose id', () => {
    const h = setup()
    expect(() => h.coordinator.completePurpose('missing')).toThrow(/not found/)
  })
})

describe('PurposeCoordinator launch cancellation', () => {
  it('cancelLaunch disposes the pending watcher so a later readiness signal is a no-op', () => {
    const h = setup()
    h.coordinator.startNewSession(0, 'C:\\repo', 'fix the bug')

    h.coordinator.cancelLaunch(0)
    expect(h.watcher.disposed).toBe(true)

    // notePtyOutput/noteStatusLineEvent after cancellation must not throw (no watcher registered).
    expect(() => h.coordinator.notePtyOutput(0)).not.toThrow()
    expect(() => h.coordinator.noteStatusLineEvent(0)).not.toThrow()
  })

  it('notePtyOutput/noteStatusLineEvent forward to the active watcher for the pane', () => {
    const onStatusLineEvent = vi.fn()
    const onPtyOutput = vi.fn()
    const h = setup({
      createWatcher: () => ({ onStatusLineEvent, onPtyOutput, dispose: () => {} })
    })
    h.coordinator.startNewSession(0, 'C:\\repo', 'fix the bug')

    h.coordinator.notePtyOutput(0)
    h.coordinator.noteStatusLineEvent(0)

    expect(onPtyOutput).toHaveBeenCalledTimes(1)
    expect(onStatusLineEvent).toHaveBeenCalledTimes(1)
  })
})
