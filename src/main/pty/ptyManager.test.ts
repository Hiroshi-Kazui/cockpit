// Pins the FIX (architect, M4 iter2 #4) generation-guard invariant: respawning a pane's pty must not
// let the *old* instance's later, asynchronously-arriving onExit/onData events be mistaken for the
// *new* instance's state -- which would otherwise let a stale exit event wrongly dispose a freshly
// armed PurposeCoordinator launch watcher (main/index.ts wires PtyManager's onExit -> cancelLaunch).
// node-pty and resolveClaude are mocked so no real process/PATH lookup is involved.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as nodePty from 'node-pty'
import { PtyManager, type PtyManagerDeps } from './ptyManager'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('./resolveClaude', () => ({
  resolveClaude: () => ({ path: 'C:\\tools\\claude.exe', kind: 'exe' as const }),
  buildSpawnCommand: (resolution: { path: string }, args: readonly string[]) => ({
    command: resolution.path,
    args: [...args]
  })
}))

interface FakePty {
  pid: number
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  onData: (cb: (data: string) => void) => void
  onExit: (cb: (e: { exitCode: number; signal: number | undefined }) => void) => void
  emitData: (data: string) => void
  emitExit: (exitCode: number, signal?: number) => void
}

function makeFakePty(pid: number): FakePty {
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(e: { exitCode: number; signal: number | undefined }) => void> = []
  return {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (cb) => {
      dataListeners.push(cb)
    },
    onExit: (cb) => {
      exitListeners.push(cb)
    },
    emitData: (data) => {
      for (const l of dataListeners) l(data)
    },
    emitExit: (exitCode, signal) => {
      for (const l of exitListeners) l({ exitCode, signal })
    }
  }
}

function makeDeps(events: PtyManagerDeps['events']): PtyManagerDeps {
  return {
    events,
    getClaudePathOverride: () => null,
    prepareTelemetry: () => ({ settingsPath: 'C:\\settings.json', extraEnv: {} })
  }
}

describe('PtyManager respawn generation guard', () => {
  let ptys: FakePty[]
  let onDataEvents: Array<{ pane: number; data: string }>
  let onExitEvents: Array<{ pane: number; exitCode: number; signal: number | undefined }>
  let manager: PtyManager

  beforeEach(() => {
    ptys = []
    let pid = 1000
    const spawnMock = vi.mocked(nodePty).spawn
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => {
      const fake = makeFakePty(pid++)
      ptys.push(fake)
      return fake as unknown as ReturnType<typeof nodePty.spawn>
    })
    onDataEvents = []
    onExitEvents = []
    manager = new PtyManager(
      makeDeps({
        onData: (pane, data) => onDataEvents.push({ pane, data }),
        onExit: (pane, exitCode, signal) => onExitEvents.push({ pane, exitCode, signal })
      })
    )
  })

  it('spawning again for the same pane kills the previous pty and swaps in a new instance', () => {
    manager.spawn(0, 'C:\\repo')
    const first = ptys[0]

    manager.spawn(0, 'C:\\repo')
    const second = ptys[1]

    expect(first.kill).toHaveBeenCalledTimes(1)
    expect(second).not.toBe(first)
  })

  it('propagates onData/onExit normally for the current (non-superseded) instance', () => {
    manager.spawn(0, 'C:\\repo')
    const proc = ptys[0]

    proc.emitData('hello')
    proc.emitExit(1, undefined)

    expect(onDataEvents).toEqual([{ pane: 0, data: 'hello' }])
    expect(onExitEvents).toEqual([{ pane: 0, exitCode: 1, signal: undefined }])
  })

  it('still propagates onExit for a genuine kill with no respawn', () => {
    manager.spawn(0, 'C:\\repo')
    const proc = ptys[0]

    manager.kill(0)
    // node-pty's real exit event arrives asynchronously after kill(); simulate that here.
    proc.emitExit(0, undefined)

    expect(onExitEvents).toEqual([{ pane: 0, exitCode: 0, signal: undefined }])
  })

  it('ignores a stale onExit/onData from a pty instance superseded by a respawn (core FIX)', () => {
    manager.spawn(0, 'C:\\repo')
    const stale = ptys[0]

    // Respawn while the old process is still (asynchronously) shutting down -- e.g. TD-7 "再開".
    manager.spawn(0, 'C:\\repo')
    onDataEvents.length = 0
    onExitEvents.length = 0

    // The old instance's real exit/data events arrive late, after the new spawn already replaced it.
    stale.emitData('stale output')
    stale.emitExit(0, undefined)

    expect(onDataEvents).toEqual([])
    expect(onExitEvents).toEqual([])
  })

  it('does not let a respawned-over pty exit reach downstream launch cancellation (integration-shaped)', () => {
    // Regression shape for the architect-flagged hazard: main/index.ts wires PtyManager's onExit event
    // straight to purposeCoordinator.cancelLaunch(pane). If a superseded pty's exit ever leaked through
    // again, a launch watcher freshly armed for the *new* spawn would be wrongly disposed before it
    // could ever send the initial prompt.
    const cancelLaunchCalls: number[] = []
    const localManager = new PtyManager(
      makeDeps({
        onData: () => {},
        onExit: (pane) => {
          cancelLaunchCalls.push(pane)
        }
      })
    )

    localManager.spawn(0, 'C:\\repo')
    const stale = ptys[ptys.length - 1]
    localManager.spawn(0, 'C:\\repo') // respawn while the old process is still shutting down

    stale.emitExit(0, undefined) // old process's real exit arrives late

    expect(cancelLaunchCalls).toEqual([])
  })

  it('keeps the map entry for the current instance when a stale exit is delivered after a respawn', () => {
    manager.spawn(0, 'C:\\repo')
    const stale = ptys[0]
    manager.spawn(0, 'C:\\repo')
    const current = ptys[1]

    stale.emitExit(0, undefined)

    // The pane must still be reported as running the *new* instance, not wiped out by the stale exit.
    expect(manager.isRunning(0)).toBe(true)
    manager.write(0, 'x')
    expect(current.write).toHaveBeenCalledWith('x')
  })

  // M4 FIX iter3 (code #4): generations Map must clear its per-pane entry on kill()/killAll(),
  // symmetric with the `panes` Map, without regressing the guard's correctness pinned above.
  describe('generations Map symmetry with panes Map (M4 FIX iter3 #4)', () => {
    it('kill() clears the generations entry so a later respawn starts from a clean guard state', () => {
      manager.spawn(0, 'C:\\repo')
      manager.kill(0)
      onExitEvents.length = 0

      // Respawn after an explicit kill (no pending stale exit in flight): the new instance's own
      // events must propagate normally, proving no leftover generation entry confuses the guard.
      manager.spawn(0, 'C:\\repo')
      const fresh = ptys[ptys.length - 1]
      fresh.emitData('after respawn')
      fresh.emitExit(0, undefined)

      expect(onDataEvents).toEqual([{ pane: 0, data: 'after respawn' }])
      expect(onExitEvents).toEqual([{ pane: 0, exitCode: 0, signal: undefined }])
    })

    it("killAll() clears every pane's generations entry symmetrically with panes", () => {
      manager.spawn(0, 'C:\\repo')
      manager.spawn(1, 'C:\\repo')
      manager.killAll()
      onExitEvents.length = 0

      const [proc0, proc1] = ptys
      proc0.emitExit(0, undefined)
      proc1.emitExit(0, undefined)

      // No respawn happened for either pane, so both genuine kills' own exit events must still
      // propagate -- the same invariant as the single-pane "genuine kill with no respawn" case.
      expect(onExitEvents).toEqual(
        expect.arrayContaining([
          { pane: 0, exitCode: 0, signal: undefined },
          { pane: 1, exitCode: 0, signal: undefined }
        ])
      )
      expect(onExitEvents).toHaveLength(2)
    })
  })
})
