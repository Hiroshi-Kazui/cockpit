// Pins the M4 FIX iter3 (code #5) isRunning guard: paneLaunchStart/paneLaunchResume must reject a pane
// that already has a running pty rather than let PtyManager.spawn()'s implicit kill-and-replace
// (ptyManager.ts) silently orphan the previous session's purpose row -- its `ended_at` never gets set
// because the old pty is killed out from under it instead of exiting on its own. The renderer normally
// can't reach this (Pane.tsx hides the "＋ 新規セッション"/"再開" affordances while `running` is true),
// so this guard is defense-in-depth at the Main-side IPC boundary.
//
// PtyManager/PurposeCoordinator/UsageCoordinator are only imported as *types* here (never as runtime
// values), so this test never touches node-pty/better-sqlite3 -- fake objects cast to those types are
// enough, since handlers.ts only ever calls methods on them.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import type { BrowserWindow } from 'electron'
import { registerIpcHandlers, unregisterIpcHandlers } from './handlers'
import {
  IpcChannels,
  type ArchiveListSessionsRequest,
  type ArchiveReadSessionRequest,
  type PaneLaunchStartRequest,
  type PaneLaunchStartResult,
  type PaneLaunchResumeRequest,
  type PaneLaunchResumeResult
} from '../../shared/ipc'
import type { PtyManager } from '../pty/ptyManager'
import type { PurposeCoordinator } from '../pty/purposeCoordinator'
import type { UsageCoordinator } from '../telemetry/usageCoordinator'
import type { ArchiveBrowserPort } from '../archive/archiveBrowser'
import type { MirrorControlPort } from '../archive/mirror/mirrorCoordinator'

type Handler = (event: unknown, req: unknown) => unknown

const registeredHandlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      registeredHandlers.set(channel, fn)
    },
    removeHandler: (channel: string) => {
      registeredHandlers.delete(channel)
    }
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showMessageBox: vi.fn()
  }
}))

function makeFakePtyManager(isRunning: (pane: number) => boolean): PtyManager {
  return { isRunning } as unknown as PtyManager
}

function makeFakePurposeCoordinator(): PurposeCoordinator & {
  startNewSession: ReturnType<typeof vi.fn>
  resumeSession: ReturnType<typeof vi.fn>
} {
  return {
    startNewSession: vi.fn((): PaneLaunchStartResult => ({ pid: 111, purposeId: 'purpose-1' })),
    resumeSession: vi.fn((): PaneLaunchResumeResult => ({ pid: 222 }))
  } as unknown as PurposeCoordinator & {
    startNewSession: ReturnType<typeof vi.fn>
    resumeSession: ReturnType<typeof vi.fn>
  }
}

function makeFakeArchiveBrowser(): ArchiveBrowserPort & {
  listSessions: ReturnType<typeof vi.fn>
  readSession: ReturnType<typeof vi.fn>
} {
  return {
    listSessions: vi.fn(() => []),
    readSession: vi.fn(() =>
      Promise.resolve({ ok: true, turns: [], truncated: false, omittedCount: 0 })
    )
  } as unknown as ArchiveBrowserPort & {
    listSessions: ReturnType<typeof vi.fn>
    readSession: ReturnType<typeof vi.fn>
  }
}

function makeFakeMirrorControl(): MirrorControlPort & {
  setOutputRoot: ReturnType<typeof vi.fn>
  getStatusSummary: ReturnType<typeof vi.fn>
  startBackfill: ReturnType<typeof vi.fn>
} {
  return {
    getOutputRoot: () => null,
    setOutputRoot: vi.fn(),
    getStatusSummary: vi.fn(() => ({ outputRoot: null, entries: [] })),
    startBackfill: vi.fn(async () => {})
  } as unknown as MirrorControlPort & {
    setOutputRoot: ReturnType<typeof vi.fn>
    getStatusSummary: ReturnType<typeof vi.fn>
    startBackfill: ReturnType<typeof vi.fn>
  }
}

function setup(isRunning: (pane: number) => boolean): {
  ptyManager: PtyManager
  purposeCoordinator: ReturnType<typeof makeFakePurposeCoordinator>
  archiveBrowser: ReturnType<typeof makeFakeArchiveBrowser>
  mirrorControl: ReturnType<typeof makeFakeMirrorControl>
} {
  registeredHandlers.clear()
  const ptyManager = makeFakePtyManager(isRunning)
  const purposeCoordinator = makeFakePurposeCoordinator()
  const archiveBrowser = makeFakeArchiveBrowser()
  const mirrorControl = makeFakeMirrorControl()
  const usageCoordinator = { refreshDisplay: vi.fn() } as unknown as UsageCoordinator
  // M6: setArchiveOutputRoot (called by the archiveOutputRootSet handler) does a raw db.prepare(...).run(...)
  // -- stub just enough of better-sqlite3's shape for that call to no-op rather than throw, matching this
  // test file's existing convention of never touching a real SQLite engine (see this file's header comment).
  const db = { prepare: vi.fn(() => ({ run: vi.fn() })) } as unknown as Database
  const window = {} as unknown as BrowserWindow
  registerIpcHandlers(
    window,
    db,
    ptyManager,
    usageCoordinator,
    purposeCoordinator,
    archiveBrowser,
    'C:\\fake\\userData\\archive',
    mirrorControl
  )
  return { ptyManager, purposeCoordinator, archiveBrowser, mirrorControl }
}

describe('paneLaunchStart/paneLaunchResume isRunning guard (M4 FIX iter3 #5)', () => {
  beforeEach(() => {
    unregisterIpcHandlers()
    registeredHandlers.clear()
  })

  it('rejects paneLaunchStart when the pane already has a running pty, without calling startNewSession', () => {
    const { purposeCoordinator } = setup(() => true)
    const handler = registeredHandlers.get(IpcChannels.paneLaunchStart)
    expect(handler).toBeDefined()
    const req: PaneLaunchStartRequest = { pane: 0, cwd: 'C:\\repo', purposeText: '目的テキスト' }

    expect(() => handler?.(undefined, req)).toThrow(/already has a running claude process/)
    expect(purposeCoordinator.startNewSession).not.toHaveBeenCalled()
  })

  it('allows paneLaunchStart through to startNewSession when the pane has no running pty', () => {
    const { purposeCoordinator } = setup(() => false)
    const handler = registeredHandlers.get(IpcChannels.paneLaunchStart)
    const req: PaneLaunchStartRequest = { pane: 0, cwd: 'C:\\repo', purposeText: '目的テキスト' }

    const result = handler?.(undefined, req)

    expect(result).toEqual({ pid: 111, purposeId: 'purpose-1' })
    expect(purposeCoordinator.startNewSession).toHaveBeenCalledWith(0, 'C:\\repo', '目的テキスト')
  })

  it('allows an empty purposeText through to startNewSession (spec §4.2: 目的テキストの入力は任意)', () => {
    const { purposeCoordinator } = setup(() => false)
    const handler = registeredHandlers.get(IpcChannels.paneLaunchStart)
    const req: PaneLaunchStartRequest = { pane: 0, cwd: 'C:\\repo', purposeText: '' }

    const result = handler?.(undefined, req)

    expect(result).toEqual({ pid: 111, purposeId: 'purpose-1' })
    expect(purposeCoordinator.startNewSession).toHaveBeenCalledWith(0, 'C:\\repo', '')
  })

  it('rejects a non-string purposeText', () => {
    setup(() => false)
    const handler = registeredHandlers.get(IpcChannels.paneLaunchStart)
    const req = { pane: 0, cwd: 'C:\\repo', purposeText: null } as unknown as PaneLaunchStartRequest

    expect(() => handler?.(undefined, req)).toThrow(/Invalid purposeText/)
  })

  it('rejects paneLaunchResume when the pane already has a running pty, without calling resumeSession', () => {
    const { purposeCoordinator } = setup(() => true)
    const handler = registeredHandlers.get(IpcChannels.paneLaunchResume)
    const req: PaneLaunchResumeRequest = { pane: 1, cwd: 'C:\\repo' }

    expect(() => handler?.(undefined, req)).toThrow(/already has a running claude process/)
    expect(purposeCoordinator.resumeSession).not.toHaveBeenCalled()
  })

  it('allows paneLaunchResume through to resumeSession when the pane has no running pty', () => {
    const { purposeCoordinator } = setup(() => false)
    const handler = registeredHandlers.get(IpcChannels.paneLaunchResume)
    const req: PaneLaunchResumeRequest = { pane: 1, cwd: 'C:\\repo' }

    const result = handler?.(undefined, req)

    expect(result).toEqual({ pid: 222 })
    expect(purposeCoordinator.resumeSession).toHaveBeenCalledWith(1, 'C:\\repo')
  })
})

// M5 (spec §4.4): the two read-only archive-browsing handlers. No write/delete channel is registered
// anywhere in handlers.ts for archive data (AC "閲覧は読み取り専用...アーカイブへの編集・削除UIが存在
// しない") -- these tests only cover validation + delegation, not the real SQLite/filesystem behavior
// (see archiveBrowser.test.ts/archiveReader.test.ts/sessionRepo.ts for those).
describe('archiveListSessions / archiveReadSession', () => {
  beforeEach(() => {
    unregisterIpcHandlers()
    registeredHandlers.clear()
  })

  it('delegates a valid list request straight through to archiveBrowser.listSessions', () => {
    const { archiveBrowser } = setup(() => false)
    const handler = registeredHandlers.get(IpcChannels.archiveListSessions)
    const req: ArchiveListSessionsRequest = { searchText: 'README' }

    handler?.(undefined, req)

    expect(archiveBrowser.listSessions).toHaveBeenCalledWith(req)
  })

  it('allows an empty searchText through (no filter)', () => {
    const { archiveBrowser } = setup(() => false)
    const handler = registeredHandlers.get(IpcChannels.archiveListSessions)

    handler?.(undefined, { searchText: '' })

    expect(archiveBrowser.listSessions).toHaveBeenCalledWith({ searchText: '' })
  })

  it('rejects a non-string searchText', () => {
    setup(() => false)
    const handler = registeredHandlers.get(IpcChannels.archiveListSessions)
    const req = { searchText: null } as unknown as ArchiveListSessionsRequest

    expect(() => handler?.(undefined, req)).toThrow(/Invalid searchText/)
  })

  it('rejects a non-positive-integer limit', () => {
    setup(() => false)
    const handler = registeredHandlers.get(IpcChannels.archiveListSessions)

    expect(() => handler?.(undefined, { searchText: '', limit: 0 })).toThrow(/Invalid limit/)
    expect(() => handler?.(undefined, { searchText: '', limit: 1.5 })).toThrow(/Invalid limit/)
  })

  it('rejects a negative offset', () => {
    setup(() => false)
    const handler = registeredHandlers.get(IpcChannels.archiveListSessions)

    expect(() => handler?.(undefined, { searchText: '', offset: -1 })).toThrow(/Invalid offset/)
  })

  it('delegates a valid read request straight through to archiveBrowser.readSession', async () => {
    const { archiveBrowser } = setup(() => false)
    const handler = registeredHandlers.get(IpcChannels.archiveReadSession)
    const req: ArchiveReadSessionRequest = { sessionId: 'sess-1' }

    const result = await handler?.(undefined, req)

    expect(archiveBrowser.readSession).toHaveBeenCalledWith('sess-1')
    expect(result).toEqual({ ok: true, turns: [], truncated: false, omittedCount: 0 })
  })

  it('rejects an empty sessionId', async () => {
    setup(() => false)
    const handler = registeredHandlers.get(IpcChannels.archiveReadSession)

    await expect(handler?.(undefined, { sessionId: '' })).rejects.toThrow(/Invalid sessionId/)
  })
})

// M6 (spec §4.4.1, ADR-0008): archive output-destination mirroring IPC surface.
describe('archiveOutputRootSet / archiveMirrorStatusGet / archiveBackfillStart', () => {
  beforeEach(() => {
    unregisterIpcHandlers()
    registeredHandlers.clear()
  })

  it('clearing (root: null) always succeeds and never probes the filesystem', async () => {
    const { mirrorControl } = setup(() => false)
    const handler = registeredHandlers.get(IpcChannels.archiveOutputRootSet)

    const result = await handler?.(undefined, { root: null })

    expect(result).toEqual({ ok: true })
    expect(mirrorControl.setOutputRoot).toHaveBeenCalledWith(null)
  })

  it('rejects a candidate root that is the spool itself or a subdirectory of it (self-mirror prevention)', async () => {
    const { mirrorControl } = setup(() => false)
    const handler = registeredHandlers.get(IpcChannels.archiveOutputRootSet)

    const result = await handler?.(undefined, { root: 'C:\\fake\\userData\\archive\\some-session' })

    expect(result).toEqual({ ok: false, reason: expect.stringContaining('スプール') })
    expect(mirrorControl.setOutputRoot).not.toHaveBeenCalled()
  })

  it('accepts a valid writable candidate root, persists it, and activates the mirror coordinator', async () => {
    const { mirrorControl } = setup(() => false)
    const handler = registeredHandlers.get(IpcChannels.archiveOutputRootSet)
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-handlers-test-'))

    try {
      const result = await handler?.(undefined, { root: tmpRoot })
      expect(result).toEqual({ ok: true })
      expect(mirrorControl.setOutputRoot).toHaveBeenCalledWith(tmpRoot)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('reports a probe failure as a typed result rather than throwing (silent failure prohibited)', async () => {
    const { mirrorControl } = setup(() => false)
    const handler = registeredHandlers.get(IpcChannels.archiveOutputRootSet)
    const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-handlers-test-'))
    const blockedByFile = path.join(tmpParent, 'blocked')
    fs.writeFileSync(blockedByFile, 'not a directory')

    try {
      const result = await handler?.(undefined, { root: blockedByFile })
      expect(result).toEqual({ ok: false, reason: expect.any(String) })
      expect(mirrorControl.setOutputRoot).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(tmpParent, { recursive: true, force: true })
    }
  })

  it('archiveMirrorStatusGet delegates straight through to mirrorControl.getStatusSummary', () => {
    const { mirrorControl } = setup(() => false)
    const handler = registeredHandlers.get(IpcChannels.archiveMirrorStatusGet)

    const result = handler?.(undefined, undefined)

    expect(mirrorControl.getStatusSummary).toHaveBeenCalled()
    expect(result).toEqual({ outputRoot: null, entries: [] })
  })

  it('archiveBackfillStart delegates to mirrorControl.startBackfill with a progress callback', async () => {
    const { mirrorControl } = setup(() => false)
    const handler = registeredHandlers.get(IpcChannels.archiveBackfillStart)

    await handler?.(undefined, undefined)

    expect(mirrorControl.startBackfill).toHaveBeenCalledTimes(1)
    expect(mirrorControl.startBackfill).toHaveBeenCalledWith(expect.any(Function))
  })
})
