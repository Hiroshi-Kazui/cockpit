// Behavioral tests for SessionCoordinator: session linking on session_id change (TD-2), origin
// dialog/clear/resume derivation, ended_at = last-observed-activity (TD-3), and app-quit cleanup.
// Uses in-memory fakes for SessionStore/PurposeStore/ArchiverPort (ports.ts) instead of a real SQLite
// engine, since better-sqlite3's native binary is rebuilt for Electron's ABI and cannot load under
// plain Node/vitest (verified empirically: NODE_MODULE_VERSION 130 vs required 137).
import { describe, expect, it, vi } from 'vitest'
import { SessionCoordinator } from './sessionCoordinator'
import type {
  ArchiverPort,
  CreateSessionParams,
  PurposeStore,
  SessionRow,
  SessionStore
} from './ports'
import type { PurposeSummary, SessionArchiveErrorEvent } from '../../shared/ipc'

function createFakeStore(): SessionStore & { rows: Map<string, SessionRow> } {
  const rows = new Map<string, SessionRow>()
  return {
    rows,
    createSession(params: CreateSessionParams) {
      rows.set(params.id, {
        id: params.id,
        pane: params.pane,
        purposeId: params.purposeId,
        origin: params.origin,
        purpose: params.purpose,
        title: params.title,
        cwd: params.cwd,
        startedAt: params.startedAt,
        endedAt: null,
        jsonlPath: params.jsonlPath,
        model: params.model,
        tokensIn: 0,
        tokensOut: 0,
        tokensCacheRead: 0,
        tokensCacheWrite: 0
      })
    },
    reopenSession(id, originOverride) {
      const row = rows.get(id)
      if (!row) return
      row.endedAt = null
      if (originOverride) row.origin = originOverride
    },
    closeSession(id, endedAt) {
      const row = rows.get(id)
      if (row) row.endedAt = endedAt
    },
    updateModelIfNull(id, model) {
      const row = rows.get(id)
      if (row && row.model === null) row.model = model
    },
    addTokens(id, usage) {
      const row = rows.get(id)
      if (!row) return
      row.tokensIn += usage.inputTokens
      row.tokensOut += usage.outputTokens
      row.tokensCacheRead += usage.cacheReadTokens
      row.tokensCacheWrite += usage.cacheCreationTokens
    },
    getSession(id) {
      return rows.get(id) ?? null
    },
    getAllOpenSessions() {
      return [...rows.values()].filter((r) => r.endedAt === null)
    }
  }
}

function createFakePurposeStore(active: PurposeSummary | null = null): PurposeStore {
  return { getActivePurposeForPane: () => active }
}

function createFakeArchiver(): ArchiverPort & {
  attachCalls: Array<{ sessionId: string; transcriptPath: string; archiveDir: string }>
  detachCalls: string[]
} {
  const attachCalls: Array<{ sessionId: string; transcriptPath: string; archiveDir: string }> = []
  const detachCalls: string[] = []
  return {
    attachCalls,
    detachCalls,
    attach(sessionId, transcriptPath, archiveDir) {
      attachCalls.push({ sessionId, transcriptPath, archiveDir })
      return `${archiveDir}/transcript.jsonl`
    },
    detach(sessionId) {
      detachCalls.push(sessionId)
    }
  }
}

interface SetupOptions {
  activePurpose?: PurposeSummary | null
  clock?: () => number
  archiveDirFor?: (sessionId: string) => string | null
  claudeHomeDir?: string
}

// Existing tests below use transcript paths like 'C:\t\s1.jsonl'; default claudeHomeDir to 'C:\t' so
// those remain valid under isTranscriptPathAllowed without having to rewrite every fixture path. Tests
// exercising the transcript_path validation itself override claudeHomeDir explicitly.
function setup(options: SetupOptions = {}) {
  const store = createFakeStore()
  const purposes = createFakePurposeStore(options.activePurpose ?? null)
  const archiver = createFakeArchiver()
  const updates: unknown[] = []
  const archiveErrors: SessionArchiveErrorEvent[] = []
  const coordinator = new SessionCoordinator({
    store,
    purposes,
    archiver,
    archiveDirFor: options.archiveDirFor ?? ((sessionId) => `/archive/${sessionId}`),
    onSessionUpdated: (summary) => updates.push(summary),
    onArchiveError: (event) => archiveErrors.push(event),
    now: options.clock,
    claudeHomeDir: options.claudeHomeDir ?? 'C:\\t'
  })
  return { store, purposes, archiver, updates, archiveErrors, coordinator }
}

describe('SessionCoordinator', () => {
  it('creates a new session row with origin=dialog on the first statusLine message after a pane launch', () => {
    const { store, archiver, coordinator } = setup()
    coordinator.onPaneLaunched(0, 'C:\\work\\repo')
    coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })

    const row = store.getSession('s1')
    expect(row?.origin).toBe('dialog')
    expect(row?.cwd).toBe('C:\\work\\repo')
    expect(row?.endedAt).toBeNull()
    expect(archiver.attachCalls).toEqual([
      { sessionId: 's1', transcriptPath: 'C:\\t\\s1.jsonl', archiveDir: '/archive/s1' }
    ])
  })

  it('links a new session to the pane active purpose, copying text/title (TD-2)', () => {
    const purpose: PurposeSummary = {
      id: 'p1',
      pane: 0,
      text: 'refactor the parser',
      title: 'Parser refactor',
      status: 'active',
      createdAt: 1,
      completedAt: null
    }
    const { store, coordinator } = setup({ activePurpose: purpose })
    coordinator.onPaneLaunched(0, 'C:\\repo')
    coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })

    const row = store.getSession('s1')
    expect(row?.purposeId).toBe('p1')
    expect(row?.purpose).toBe('refactor the parser')
    expect(row?.title).toBe('Parser refactor')
  })

  it('closes the old row and opens a new one with origin=clear when session_id changes mid-lifecycle (TD-2)', () => {
    let clock = 1000
    const { store, coordinator } = setup({ clock: () => clock })
    coordinator.onPaneLaunched(0, 'C:\\repo')
    coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })

    clock = 2000
    coordinator.onRawMessage({ pane: 0, session_id: 's2', transcript_path: 'C:\\t\\s2.jsonl' })

    const s1 = store.getSession('s1')
    const s2 = store.getSession('s2')
    expect(s1?.endedAt).toBe(1000) // last activity recorded for s1 before the switch
    expect(s2?.origin).toBe('clear')
    expect(s2?.endedAt).toBeNull()
  })

  it('reopens a known session_id resurfacing as /resume instead of creating a duplicate row (TD-2)', () => {
    let clock = 1000
    const { store, archiver, coordinator } = setup({ clock: () => clock })
    coordinator.onPaneLaunched(0, 'C:\\repo')
    coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })
    clock = 2000
    coordinator.onRawMessage({ pane: 0, session_id: 's2', transcript_path: 'C:\\t\\s2.jsonl' })

    // s1 resurfaces (e.g. /resume back to it)
    clock = 3000
    coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })

    expect(store.rows.size).toBe(2) // no third row created
    const s1 = store.getSession('s1')
    expect(s1?.endedAt).toBeNull() // reopened
    expect(s1?.origin).toBe('dialog') // original origin preserved, not overwritten
    expect(archiver.attachCalls.filter((c) => c.sessionId === 's1').length).toBe(2)
  })

  // M4 (TD-7): onPaneLaunched's optional 3rd param controls the *first* linked session's origin for a
  // fresh pty lifecycle -- 'dialog' (default, M2 behavior unchanged) vs 'restart' (one-click "再開").
  it('creates a new session row with origin=restart when the pane was launched via onPaneLaunched(..., "restart") (TD-7)', () => {
    const { store, coordinator } = setup()
    coordinator.onPaneLaunched(0, 'C:\\repo', 'restart')
    coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })

    expect(store.getSession('s1')?.origin).toBe('restart')
  })

  it('still uses origin=clear for a session_id change later in a restart-launched lifecycle (TD-2 unaffected)', () => {
    const { store, coordinator } = setup()
    coordinator.onPaneLaunched(0, 'C:\\repo', 'restart')
    coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })
    coordinator.onRawMessage({ pane: 0, session_id: 's2', transcript_path: 'C:\\t\\s2.jsonl' })

    expect(store.getSession('s1')?.origin).toBe('restart')
    expect(store.getSession('s2')?.origin).toBe('clear')
  })

  it('overrides origin to restart when a restart-launch resurfaces an existing (reopened) session_id (TD-7 edge case)', () => {
    // Simulates `--continue` reusing a session_id that already has a row from a prior, now-closed pty
    // lifecycle (e.g. from before an app restart) -- session_id is the primary key (spec §5), so this
    // must be a reopen, not a second row; the origin is still overridden to reflect the restart intent.
    const { store, coordinator } = setup()
    coordinator.onPaneLaunched(0, 'C:\\repo')
    coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })
    coordinator.onPtyExited(0) // closes s1, simulating the app-restart boundary

    coordinator.onPaneLaunched(0, 'C:\\repo', 'restart')
    coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })

    expect(store.rows.size).toBe(1) // reopened, not duplicated
    expect(store.getSession('s1')?.origin).toBe('restart')
    expect(store.getSession('s1')?.endedAt).toBeNull()
  })

  it('does not recreate a row for repeated statusLine messages with the same session_id', () => {
    const { store, archiver, coordinator } = setup()
    coordinator.onPaneLaunched(0, 'C:\\repo')
    coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })
    coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })
    coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })

    expect(store.rows.size).toBe(1)
    expect(archiver.attachCalls.length).toBe(1)
  })

  it('closes the session on pty exit using the last recorded activity time (TD-3 path 1)', () => {
    let clock = 1000
    const { store, coordinator } = setup({ clock: () => clock })
    coordinator.onPaneLaunched(0, 'C:\\repo')
    coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })
    clock = 9999 // pty exit is detected "later", but ended_at must be the last activity, not this
    coordinator.onPtyExited(0)

    expect(store.getSession('s1')?.endedAt).toBe(1000)
  })

  it('aggregates JSONL usage into token totals and records activity from the archived mtime (spec §4.5)', () => {
    // Fixed clock so the statusLine-link timestamp (1000) is deterministically earlier than the
    // synthetic JSONL mtime (5000) below -- recordActivity takes the max of both signals (TD-3), so
    // this must hold for the assertion to be meaningful.
    const { store, coordinator } = setup({ clock: () => 1000 })
    coordinator.onPaneLaunched(0, 'C:\\repo')
    coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })

    coordinator.onJsonlEntries(
      's1',
      [
        {
          timestampMs: 1,
          model: 'claude-x',
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheCreationTokens: 0 },
          userText: null,
          isUserTurnMissingHumanOrigin: false
        },
        {
          timestampMs: 2,
          model: null,
          usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
          userText: null,
          isUserTurnMissingHumanOrigin: false
        }
      ],
      5000
    )

    const row = store.getSession('s1')
    expect(row).toMatchObject({
      tokensIn: 12,
      tokensOut: 6,
      tokensCacheRead: 1,
      tokensCacheWrite: 0
    })

    coordinator.onPtyExited(0)
    expect(store.getSession('s1')?.endedAt).toBe(5000) // JSONL mtime activity, not Date.now()
  })

  it('closes every open session and detaches the archiver on app quit (TD-3 path 3)', () => {
    const { store, archiver, coordinator } = setup()
    coordinator.onPaneLaunched(0, 'C:\\repo')
    coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })
    coordinator.onPaneLaunched(1, 'C:\\repo2')
    coordinator.onRawMessage({ pane: 1, session_id: 's2', transcript_path: 'C:\\t\\s2.jsonl' })

    coordinator.closeAllOpenSessions()

    expect(store.getSession('s1')?.endedAt).not.toBeNull()
    expect(store.getSession('s2')?.endedAt).not.toBeNull()
    expect(archiver.detachCalls.sort()).toEqual(['s1', 's2'])
  })

  it('discards a message with no session_id/transcript_path without creating a row', () => {
    const { store, coordinator } = setup()
    coordinator.onPaneLaunched(0, 'C:\\repo')
    coordinator.onRawMessage({ pane: 0 })
    expect(store.rows.size).toBe(0)
  })

  it('discards a message with an out-of-range pane without throwing (spec §7 tolerance)', () => {
    const { store, coordinator } = setup()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() =>
      coordinator.onRawMessage({ pane: 9, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })
    ).not.toThrow()
    expect(store.rows.size).toBe(0)
    spy.mockRestore()
  })

  // M2 FIX iteration 2 (security/blocking): the named pipe carrying these messages is unauthenticated
  // (TD-4), so session_id and transcript_path must never reach filesystem path construction unvalidated.
  describe('security: pipe-sourced session_id / transcript_path validation', () => {
    it('discards a message whose session_id contains .. without creating a row or attaching the archiver', () => {
      const { store, archiver, coordinator } = setup()
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      coordinator.onPaneLaunched(0, 'C:\\repo')

      coordinator.onRawMessage({
        pane: 0,
        session_id: '..\\..\\evil',
        transcript_path: 'C:\\t\\s1.jsonl'
      })

      expect(store.rows.size).toBe(0)
      expect(archiver.attachCalls).toEqual([])
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })

    it('discards a message whose session_id contains a path separator', () => {
      const { store, coordinator } = setup()
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      coordinator.onPaneLaunched(0, 'C:\\repo')

      coordinator.onRawMessage({
        pane: 0,
        session_id: 'foo/bar',
        transcript_path: 'C:\\t\\s1.jsonl'
      })

      expect(store.rows.size).toBe(0)
      spy.mockRestore()
    })

    it('accepts a normal UUID-shaped session_id unaffected by the whitelist', () => {
      const { store, coordinator } = setup()
      coordinator.onPaneLaunched(0, 'C:\\repo')

      coordinator.onRawMessage({
        pane: 0,
        session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        transcript_path: 'C:\\t\\s1.jsonl'
      })

      expect(store.rows.size).toBe(1)
    })

    it('refuses to link a session when archiveDirFor reports containment failure (defense-in-depth), discarding without creating a row', () => {
      const { store, archiver, coordinator } = setup({ archiveDirFor: () => null })
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      coordinator.onPaneLaunched(0, 'C:\\repo')

      coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })

      expect(store.rows.size).toBe(0)
      expect(archiver.attachCalls).toEqual([])
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })

    it('still creates the session row but skips archiver.attach when transcript_path is outside the expected claude directory, and reports an archive error', () => {
      const { store, archiver, archiveErrors, coordinator } = setup({
        claudeHomeDir: 'C:\\Users\\me\\.claude'
      })
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      coordinator.onPaneLaunched(0, 'C:\\repo')

      coordinator.onRawMessage({
        pane: 0,
        session_id: 's1',
        transcript_path: 'C:\\Windows\\System32\\config\\SAM'
      })

      expect(store.getSession('s1')).not.toBeNull()
      expect(archiver.attachCalls).toEqual([])
      expect(archiveErrors).toHaveLength(1)
      expect(archiveErrors[0]).toMatchObject({ sessionId: 's1', pane: 0 })
      spy.mockRestore()
    })

    it('attaches the archiver when transcript_path is inside the configured claude directory', () => {
      const { store, archiver, coordinator } = setup({ claudeHomeDir: 'C:\\Users\\me\\.claude' })
      coordinator.onPaneLaunched(0, 'C:\\repo')

      coordinator.onRawMessage({
        pane: 0,
        session_id: 's1',
        transcript_path: 'C:\\Users\\me\\.claude\\projects\\p\\s1.jsonl'
      })

      expect(store.getSession('s1')).not.toBeNull()
      expect(archiver.attachCalls).toHaveLength(1)
    })
  })

  // M4 FIX (major #1, eventual-consistency): PurposeCoordinator calls resyncSessionsForPurpose after a
  // purpose-text/title decision that happens out-of-band from statusLine/JSONL telemetry, to re-trigger
  // the metadata.json sidecar write for any already-open session under that purpose.
  describe('resyncSessionsForPurpose', () => {
    it('re-emits onSessionUpdated for every open session linked to the purpose, and none other', () => {
      const { store, updates, coordinator } = setup()
      coordinator.onPaneLaunched(0, 'C:\\repo')
      coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })
      coordinator.onPaneLaunched(1, 'C:\\repo2')
      coordinator.onRawMessage({ pane: 1, session_id: 's2', transcript_path: 'C:\\t\\s2.jsonl' })
      // s1 belongs to purpose p1 (as if linked while active); s2 has no purpose.
      store.rows.get('s1')!.purposeId = 'p1'
      updates.length = 0

      coordinator.resyncSessionsForPurpose('p1')

      expect(updates).toHaveLength(1)
      expect((updates[0] as { id: string }).id).toBe('s1')
    })

    it('skips a session under the purpose that has already been closed (only open sessions are resynced)', () => {
      const { store, updates, coordinator } = setup()
      coordinator.onPaneLaunched(0, 'C:\\repo')
      coordinator.onRawMessage({ pane: 0, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })
      store.rows.get('s1')!.purposeId = 'p1'
      coordinator.onPtyExited(0) // closes s1
      updates.length = 0

      coordinator.resyncSessionsForPurpose('p1')

      expect(updates).toEqual([])
    })

    it('is a no-op when no open session is linked to the purpose', () => {
      const { updates, coordinator } = setup()
      coordinator.resyncSessionsForPurpose('unknown-purpose')
      expect(updates).toEqual([])
    })
  })

  // M2 FIX iteration 2 (major #4): archive-sync failures must be surfaced, not console-only.
  describe('onArchiverError', () => {
    it('resolves the failing session back to its pane and forwards a SessionArchiveErrorEvent', () => {
      const { store, archiveErrors, coordinator } = setup()
      coordinator.onPaneLaunched(2, 'C:\\repo')
      coordinator.onRawMessage({ pane: 2, session_id: 's1', transcript_path: 'C:\\t\\s1.jsonl' })
      expect(store.getSession('s1')).not.toBeNull()

      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      coordinator.onArchiverError('s1', new Error('disk full'))
      spy.mockRestore()

      expect(archiveErrors).toHaveLength(1)
      expect(archiveErrors[0]).toEqual({ sessionId: 's1', pane: 2, message: 'disk full' })
    })

    it('reports pane=null when the failing session cannot be looked up', () => {
      const { archiveErrors, coordinator } = setup()
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      coordinator.onArchiverError('unknown-session', new Error('boom'))
      spy.mockRestore()

      expect(archiveErrors).toEqual([{ sessionId: 'unknown-session', pane: null, message: 'boom' }])
    })
  })
})
