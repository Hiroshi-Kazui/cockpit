// Behavioral tests for MirrorCoordinator against in-memory fakes (ArchiveMirrorRepoPort/SpoolReader/
// ArchiveSink) -- same rationale as sessionCoordinator.test.ts: no real SQLite/filesystem needed, and this
// keeps timer-driven behavior (debounce, retry backoff) deterministic under vi.useFakeTimers().
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MirrorCoordinator } from './mirrorCoordinator'
import type { ArchiveMirrorRepoPort, ArchiveMirrorRow } from '../../db/archiveMirrorRepo'
import type { BackfillProgressEvent } from '../../../shared/ipc'
import type { ArchiveSink } from './sink'
import type { SpoolReader } from './spoolReader'

function createFakeRepo(): ArchiveMirrorRepoPort & { rows: Map<string, ArchiveMirrorRow> } {
  const rows = new Map<string, ArchiveMirrorRow>()
  return {
    rows,
    get: (id) => (rows.has(id) ? { ...rows.get(id)! } : null),
    upsert: (row) => rows.set(row.sessionId, { ...row }),
    listAll: () => [...rows.values()].map((r) => ({ ...r })),
    listForDestRoot: (root) =>
      [...rows.values()].filter((r) => r.destRoot === root).map((r) => ({ ...r }))
  }
}

interface FakeSpoolFile {
  transcript: string
  metadata: string | null
}

function createFakeSpool(files: Map<string, FakeSpoolFile>): SpoolReader {
  return {
    statSpoolTranscript: async (id) => {
      const f = files.get(id)
      return f ? Buffer.byteLength(f.transcript, 'utf-8') : null
    },
    readSpoolBytes: async (id, offset, length) => {
      const f = files.get(id)
      if (!f) throw new Error(`no such spool session: ${id}`)
      return Buffer.from(f.transcript, 'utf-8').subarray(offset, offset + length)
    },
    readSpoolMetadata: async (id) => files.get(id)?.metadata ?? null,
    listSpoolSessionIds: () => [...files.keys()]
  }
}

interface FakeSink extends ArchiveSink {
  transcripts: Map<string, string>
  metadata: Map<string, string>
  failNextAppend: boolean
}

function createFakeSink(): FakeSink {
  const transcripts = new Map<string, string>()
  const metadata = new Map<string, string>()
  const sink: FakeSink = {
    transcripts,
    metadata,
    failNextAppend: false,
    statTranscript: async (id) =>
      transcripts.has(id) ? Buffer.byteLength(transcripts.get(id) as string, 'utf-8') : null,
    appendTranscript: async (id, offset, buffer) => {
      if (sink.failNextAppend) {
        sink.failNextAppend = false
        throw new Error('simulated destination failure')
      }
      const current = transcripts.get(id) ?? ''
      if (Buffer.byteLength(current, 'utf-8') !== offset) {
        throw new Error(
          `offset mismatch: dest has ${Buffer.byteLength(current, 'utf-8')}, expected ${offset}`
        )
      }
      transcripts.set(id, current + buffer.toString('utf-8'))
    },
    writeMetadata: async (id, json) => {
      metadata.set(id, json)
    },
    readTranscriptPrefix: async (id, length) => {
      const current = transcripts.get(id) ?? ''
      return Buffer.from(current, 'utf-8').subarray(0, length)
    }
  }
  return sink
}

describe('MirrorCoordinator (M6, ADR-0008)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is fully inert while no output root is configured (no repo writes at all)', async () => {
    const repo = createFakeRepo()
    const files = new Map<string, FakeSpoolFile>([
      ['sess-1', { transcript: 'line1\n', metadata: '{"t":1}' }]
    ])
    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(files),
      createSink: () => createFakeSink()
    })

    coordinator.onTranscriptAppended('sess-1')
    coordinator.onMetadataWritten('sess-1')
    await vi.advanceTimersByTimeAsync(5000)

    expect(repo.rows.size).toBe(0)
    expect(coordinator.getStatusSummary()).toEqual({ outputRoot: null, entries: [] })
  })

  it("mirrors a new session's transcript + metadata after the debounce window", async () => {
    const repo = createFakeRepo()
    // Empty at configure-time, deliberately -- see the coalescing test below for why (a session already
    // present before setOutputRoot is called gets rebaselined to skip its pre-existing history).
    const files = new Map<string, FakeSpoolFile>()
    const sink = createFakeSink()
    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(files),
      createSink: () => sink,
      debounceMs: 1000
    })
    coordinator.setOutputRoot('D:\\mirror')
    files.set('sess-1', { transcript: 'line1\n', metadata: '{"t":1}' })

    coordinator.onTranscriptAppended('sess-1')
    coordinator.onMetadataWritten('sess-1')
    await vi.advanceTimersByTimeAsync(1000)

    expect(sink.transcripts.get('sess-1')).toBe('line1\n')
    expect(sink.metadata.get('sess-1')).toBe('{"t":1}')
    const row = repo.get('sess-1')
    expect(row?.state).toBe('synced')
    expect(row?.syncedBytes).toBe(6)
    expect(row?.metaSynced).toBe(true)
  })

  it('coalesces rapid repeated onTranscriptAppended calls into a single debounced sync', async () => {
    const repo = createFakeRepo()
    // Empty at configure-time, deliberately: a session already present *before* setOutputRoot is called
    // gets rebaselined to skip its pre-existing history (the dedicated rebaseline test below), which would
    // make this session immediately "caught up" with nothing left to send -- adding it only *after*
    // configuring exercises the "brand-new session" path instead, where a real append is expected.
    const files = new Map<string, FakeSpoolFile>()
    const sink = createFakeSink()
    let appendCalls = 0
    const wrappedSink: FakeSink = {
      ...sink,
      appendTranscript: async (id, offset, buffer) => {
        appendCalls++
        await sink.appendTranscript(id, offset, buffer)
      }
    }
    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(files),
      createSink: () => wrappedSink,
      debounceMs: 1000
    })
    coordinator.setOutputRoot('D:\\mirror')
    files.set('sess-1', { transcript: 'abc', metadata: null })

    coordinator.onTranscriptAppended('sess-1')
    await vi.advanceTimersByTimeAsync(300)
    coordinator.onTranscriptAppended('sess-1')
    await vi.advanceTimersByTimeAsync(300)
    coordinator.onTranscriptAppended('sess-1')
    await vi.advanceTimersByTimeAsync(1000)

    expect(appendCalls).toBe(1)
    expect(sink.transcripts.get('sess-1')).toBe('abc')
  })

  it('records state=error with last_error on a destination failure and never throws to the caller', async () => {
    const repo = createFakeRepo()
    // Session added after configuring, same rationale as the coalescing test above.
    const files = new Map<string, FakeSpoolFile>()
    const sink = createFakeSink()
    sink.failNextAppend = true
    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(files),
      createSink: () => sink,
      debounceMs: 100,
      baseRetryDelayMs: 1000
    })
    coordinator.setOutputRoot('D:\\mirror')
    files.set('sess-1', { transcript: 'abc', metadata: null })

    coordinator.onTranscriptAppended('sess-1')
    await vi.advanceTimersByTimeAsync(100)

    const row = repo.get('sess-1')
    expect(row?.state).toBe('error')
    expect(row?.lastError).toMatch(/simulated destination failure/)
  })

  it('retries a failed sync with backoff and eventually succeeds once the destination recovers', async () => {
    const repo = createFakeRepo()
    // Session added after configuring, same rationale as the coalescing test above.
    const files = new Map<string, FakeSpoolFile>()
    const sink = createFakeSink()
    sink.failNextAppend = true
    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(files),
      createSink: () => sink,
      debounceMs: 100,
      baseRetryDelayMs: 1000,
      maxRetryDelayMs: 10000
    })
    coordinator.setOutputRoot('D:\\mirror')
    files.set('sess-1', { transcript: 'abc', metadata: null })

    coordinator.onTranscriptAppended('sess-1')
    await vi.advanceTimersByTimeAsync(100)
    expect(repo.get('sess-1')?.state).toBe('error')

    // Retry fires automatically; the destination is no longer failing this time.
    await vi.advanceTimersByTimeAsync(2000)
    expect(repo.get('sess-1')?.state).toBe('synced')
    expect(sink.transcripts.get('sess-1')).toBe('abc')
  })

  it('setOutputRoot rebaselines pre-existing spool sessions to skip history (ADR-0008/D-4)', async () => {
    const repo = createFakeRepo()
    const files = new Map<string, FakeSpoolFile>([
      [
        'old-session',
        { transcript: 'this is old history that predates the root switch', metadata: null }
      ]
    ])
    const sink = createFakeSink()
    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(files),
      createSink: () => sink,
      debounceMs: 100
    })

    coordinator.setOutputRoot('D:\\mirror')
    await vi.advanceTimersByTimeAsync(0)

    const row = repo.get('old-session')
    expect(row?.state).toBe('synced')
    expect(row?.syncedBytes).toBe(Buffer.byteLength(files.get('old-session')!.transcript, 'utf-8'))
    // No bytes were actually copied to the new destination -- history is skipped, not backfilled.
    expect(sink.transcripts.has('old-session')).toBe(false)

    // Only new activity from this point on is mirrored.
    files.set('old-session', {
      transcript: files.get('old-session')!.transcript + 'NEW APPENDED LINE\n',
      metadata: null
    })
    coordinator.onTranscriptAppended('old-session')
    await vi.advanceTimersByTimeAsync(100)
    expect(sink.transcripts.get('old-session')).toBe('NEW APPENDED LINE\n')
  })

  // Regression tests for a real bug: switching the output root A -> B -> A back again. The single-row
  // archive_mirror schema (spec §5) has no memory of A's own progress once the row moved to B in between,
  // so simply "trusting" whatever real bytes are physically at A is not safe on its own -- those bytes
  // could genuinely be a spool *prefix* (safe to resume from) or a post-skip *suffix* left over from before
  // A was ever switched away from (unsafe: resuming would read the wrong spool range and silently corrupt
  // it). Both outcomes are exercised below.
  describe('A -> B -> A output-root switch-back (single-row schema safety)', () => {
    it('resumes correctly when A already holds a genuine full-history prefix (never skipped)', async () => {
      const repo = createFakeRepo()
      const files = new Map<string, FakeSpoolFile>()
      const sinkA = createFakeSink()
      const sinkB = createFakeSink()
      const sinks: Record<string, FakeSink> = { 'D:\\A': sinkA, 'D:\\B': sinkB }
      const coordinator = new MirrorCoordinator({
        repo,
        spool: createFakeSpool(files),
        createSink: (root) => sinks[root],
        debounceMs: 100
      })

      // 1) Root A configured *before* sess-1 exists at all -- its entire history is genuinely, fully
      // mirrored to A via ordinary incremental sync (skip=0, a true prefix by construction).
      coordinator.setOutputRoot('D:\\A')
      await vi.advanceTimersByTimeAsync(0)
      files.set('sess-1', { transcript: 'x'.repeat(100), metadata: null })
      coordinator.onTranscriptAppended('sess-1')
      await vi.advanceTimersByTimeAsync(100)
      expect(sinkA.transcripts.get('sess-1')).toBe('x'.repeat(100))

      // 2) Switch to B -- A is left on disk untouched (D-4); B mirrors only the post-switch growth.
      coordinator.setOutputRoot('D:\\B')
      await vi.advanceTimersByTimeAsync(0)
      files.set('sess-1', { transcript: 'x'.repeat(100) + 'y'.repeat(50), metadata: null })
      coordinator.onTranscriptAppended('sess-1')
      await vi.advanceTimersByTimeAsync(100)
      expect(sinkB.transcripts.get('sess-1')).toBe('y'.repeat(50))
      expect(sinkA.transcripts.get('sess-1')).toBe('x'.repeat(100)) // untouched

      // 3) Switch back to A. Content verification confirms A's 100 bytes are a genuine spool prefix ->
      // resumes safely from there.
      coordinator.setOutputRoot('D:\\A')
      await vi.advanceTimersByTimeAsync(0)
      expect(repo.get('sess-1')?.state).toBe('synced')
      expect(repo.get('sess-1')?.syncedBytes).toBe(100)

      // 4) Further growth mirrors correctly to A, producing the *full*, uncorrupted spool content.
      files.set('sess-1', {
        transcript: 'x'.repeat(100) + 'y'.repeat(50) + 'z'.repeat(30),
        metadata: null
      })
      coordinator.onTranscriptAppended('sess-1')
      await vi.advanceTimersByTimeAsync(100)
      expect(sinkA.transcripts.get('sess-1')).toBe(
        'x'.repeat(100) + 'y'.repeat(50) + 'z'.repeat(30)
      )
      expect(repo.get('sess-1')?.state).toBe('synced')
    })

    it('refuses (state=error) rather than corrupt when A holds a post-skip suffix, and never appends to it even after further spool growth', async () => {
      const repo = createFakeRepo()
      const files = new Map<string, FakeSpoolFile>()
      const sinkA = createFakeSink()
      const sinkB = createFakeSink()
      const sinks: Record<string, FakeSink> = { 'D:\\A': sinkA, 'D:\\B': sinkB }
      const coordinator = new MirrorCoordinator({
        repo,
        spool: createFakeSpool(files),
        createSink: (root) => sinks[root],
        debounceMs: 100
      })

      // 1) sess-1 already has 50 bytes of history *before* root A is ever configured -- A's rebaseline
      // skips them (D-4), so A's real content, once populated by later growth, is a *suffix* of the spool
      // (spool[50:100]), not a genuine prefix.
      files.set('sess-1', { transcript: 'p'.repeat(50), metadata: null })
      coordinator.setOutputRoot('D:\\A')
      await vi.advanceTimersByTimeAsync(0)
      expect(sinkA.transcripts.has('sess-1')).toBe(false)
      files.set('sess-1', { transcript: 'p'.repeat(50) + 'q'.repeat(50), metadata: null })
      coordinator.onTranscriptAppended('sess-1')
      await vi.advanceTimersByTimeAsync(100)
      expect(sinkA.transcripts.get('sess-1')).toBe('q'.repeat(50)) // a suffix, not spool[0:50]

      // 2) Switch to B, grow further, switch back to A.
      coordinator.setOutputRoot('D:\\B')
      await vi.advanceTimersByTimeAsync(0)
      files.set('sess-1', {
        transcript: 'p'.repeat(50) + 'q'.repeat(50) + 'r'.repeat(50),
        metadata: null
      })
      coordinator.onTranscriptAppended('sess-1')
      await vi.advanceTimersByTimeAsync(100)

      coordinator.setOutputRoot('D:\\A')
      await vi.advanceTimersByTimeAsync(0)

      // 3) Content verification correctly detects A's 50 bytes ("q"*50) are not spool's leading 50 bytes
      // ("p"*50) -- refused, not silently resumed.
      expect(repo.get('sess-1')?.state).toBe('error')
      expect(repo.get('sess-1')?.lastError).toMatch(
        /does not match a genuine prefix|do not match a genuine prefix/
      )
      expect(sinkA.transcripts.get('sess-1')).toBe('q'.repeat(50)) // untouched -- no corruption

      // 4) Further spool growth must never trigger another automatic append to A for this session.
      files.set('sess-1', {
        transcript: 'p'.repeat(50) + 'q'.repeat(50) + 'r'.repeat(50) + 's'.repeat(50),
        metadata: null
      })
      coordinator.onTranscriptAppended('sess-1')
      await vi.advanceTimersByTimeAsync(100)
      expect(sinkA.transcripts.get('sess-1')).toBe('q'.repeat(50)) // still untouched
      expect(repo.get('sess-1')?.state).toBe('error')
    })
  })

  it('setOutputRoot(null) disables mirroring without touching existing archive_mirror rows', async () => {
    const repo = createFakeRepo()
    // Empty at configure-time (same rationale as the coalescing test above) so the first sync below is a
    // real append, not a rebaseline-skip no-op.
    const files = new Map<string, FakeSpoolFile>()
    const sink = createFakeSink()
    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(files),
      createSink: () => sink,
      debounceMs: 100
    })
    coordinator.setOutputRoot('D:\\mirror')
    files.set('sess-1', { transcript: 'abc', metadata: null })
    coordinator.onTranscriptAppended('sess-1')
    await vi.advanceTimersByTimeAsync(100)
    expect(repo.rows.size).toBe(1)
    expect(sink.transcripts.get('sess-1')).toBe('abc')

    coordinator.setOutputRoot(null)
    expect(coordinator.getStatusSummary()).toEqual({ outputRoot: null, entries: [] })
    expect(repo.rows.size).toBe(1) // row still exists, just not reported while unconfigured

    // Further activity is a no-op while unconfigured -- growing the spool file has no effect.
    files.set('sess-1', { transcript: 'abc-more-content', metadata: null })
    coordinator.onTranscriptAppended('sess-1')
    await vi.advanceTimersByTimeAsync(5000)
    expect(sink.transcripts.get('sess-1')).toBe('abc') // unchanged
  })

  it('startBackfill forces a full resync from scratch and reports progress to completion', async () => {
    const repo = createFakeRepo()
    const files = new Map<string, FakeSpoolFile>([
      ['sess-1', { transcript: 'full history 1', metadata: '{"a":1}' }],
      ['sess-2', { transcript: 'full history 2', metadata: null }]
    ])
    const sink = createFakeSink()
    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(files),
      createSink: () => sink,
      debounceMs: 100
    })
    // Simulate "root already configured, history already skipped" (as setOutputRoot would do).
    coordinator.setOutputRoot('D:\\mirror')
    await vi.advanceTimersByTimeAsync(0)
    expect(sink.transcripts.has('sess-1')).toBe(false)

    const events: BackfillProgressEvent[] = []
    await coordinator.startBackfill((e) => events.push(e))

    expect(sink.transcripts.get('sess-1')).toBe('full history 1')
    expect(sink.transcripts.get('sess-2')).toBe('full history 2')
    expect(sink.metadata.get('sess-1')).toBe('{"a":1}')
    expect(events[0]).toEqual({
      totalSessions: 2,
      processedSessions: 0,
      failedSessions: 0,
      done: false
    })
    expect(events[events.length - 1]).toEqual({
      totalSessions: 2,
      processedSessions: 2,
      failedSessions: 0,
      done: true
    })
  })

  // Regression test for a real bug: a session that was skip-rebaselined (ADR-0008/D-4) and then had *some*
  // post-config activity normally synced ends up with real (non-empty) destination content that is a
  // *suffix* of the spool, not a prefix. A prior implementation blindly rebased synced_bytes down to the
  // destination's real size and resumed an ordinary sync, which read the wrong spool range and appended it
  // -- silently corrupting the destination with duplicated/interleaved content while still reporting
  // state='synced'. Backfill must refuse (record state='error') instead.
  it('startBackfill refuses (records state=error) rather than corrupt a session whose destination holds post-skip content that is not a genuine spool prefix', async () => {
    const repo = createFakeRepo()
    const files = new Map<string, FakeSpoolFile>()
    const sink = createFakeSink()
    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(files),
      createSink: () => sink,
      debounceMs: 100
    })

    // 1) The session already has 100 bytes of history before the output root is ever configured --
    // setOutputRoot's rebaseline skips it (synced_bytes=100, destination still empty).
    files.set('sess-1', { transcript: 'x'.repeat(100), metadata: null })
    coordinator.setOutputRoot('D:\\mirror')
    await vi.advanceTimersByTimeAsync(0)
    expect(repo.get('sess-1')?.syncedBytes).toBe(100)
    expect(sink.transcripts.has('sess-1')).toBe(false)

    // 2) 50 more bytes are appended post-config -- normal incremental sync mirrors *only* this new suffix
    // (spool[100:150]), landing at the destination as its first (and only) 50 real bytes.
    files.set('sess-1', { transcript: 'x'.repeat(100) + 'y'.repeat(50), metadata: null })
    coordinator.onTranscriptAppended('sess-1')
    await vi.advanceTimersByTimeAsync(100)
    expect(sink.transcripts.get('sess-1')).toBe('y'.repeat(50))
    expect(repo.get('sess-1')?.syncedBytes).toBe(150)

    // 3) Backfill must now refuse: naively resuming from destSize=50 would append spool[50:150] onto the
    // existing spool[100:150] already at the destination, corrupting it.
    const events: BackfillProgressEvent[] = []
    await coordinator.startBackfill((e) => events.push(e))

    expect(sink.transcripts.get('sess-1')).toBe('y'.repeat(50)) // untouched -- no corruption happened
    expect(repo.get('sess-1')?.state).toBe('error')
    expect(repo.get('sess-1')?.lastError).toMatch(/cannot backfill/)
    expect(events[events.length - 1]).toEqual({
      totalSessions: 1,
      processedSessions: 1,
      failedSessions: 1,
      done: true
    })
  })

  it('startBackfill is a documented no-op (done: true immediately) when unconfigured', async () => {
    const repo = createFakeRepo()
    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(new Map()),
      createSink: () => createFakeSink()
    })
    const events: Array<{ done: boolean }> = []
    await coordinator.startBackfill((e) => events.push(e))
    expect(events).toEqual([
      { totalSessions: 0, processedSessions: 0, failedSessions: 0, done: true }
    ])
  })

  // Regression test for a real bug: the exact two-call sequence main/index.ts performs at every app
  // startup is `setOutputRoot(persistedRoot)` followed by `recoverOnStartup()` -- with archive_mirror rows
  // from a *previous* run (created before this coordinator/repo instance even exists) already on record.
  // A prior implementation had setOutputRoot's history-skipping rebaseline (ADR-0008/D-4) run
  // unconditionally whenever `newRoot !== prevRoot`, which is *always true* at startup (prevRoot starts
  // null) -- silently overwriting every session's recorded synced_bytes to "fully caught up" and making
  // recoverOnStartup's catch-up a no-op, permanently losing any tail a crash left unsynced (D-6 violation).
  it('startup order (setOutputRoot(persistedRoot) then recoverOnStartup) catches up an interrupted sync instead of rebaseline silently discarding it', async () => {
    const repo = createFakeRepo()
    const files = new Map<string, FakeSpoolFile>([
      ['sess-1', { transcript: 'abcdef', metadata: null }]
    ])
    const sink = createFakeSink()
    sink.transcripts.set('sess-1', 'abc') // pre-crash: only 3 of 6 spool bytes had reached the destination

    // Exactly what a real restart finds already in SQLite -- written by a *previous* run, before this
    // test's coordinator/repo instance is even constructed.
    repo.upsert({
      sessionId: 'sess-1',
      destRoot: 'D:\\mirror',
      syncedBytes: 3,
      metaSynced: false,
      state: 'pending',
      lastError: null,
      updatedAt: 1000
    })

    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(files),
      createSink: () => sink,
      debounceMs: 500
    })

    // The exact same two calls, in the exact same order, main/index.ts makes at startup.
    coordinator.setOutputRoot('D:\\mirror')
    coordinator.recoverOnStartup()
    await vi.advanceTimersByTimeAsync(0)

    expect(sink.transcripts.get('sess-1')).toBe('abcdef')
    expect(repo.get('sess-1')?.state).toBe('synced')
    expect(repo.get('sess-1')?.syncedBytes).toBe(6)
  })

  it('setOutputRoot does not rebaseline a session already tracked against that exact root (preserves in-progress synced_bytes on repeat configuration)', async () => {
    const repo = createFakeRepo()
    const files = new Map<string, FakeSpoolFile>([
      ['sess-1', { transcript: 'abcdef', metadata: null }]
    ])
    repo.upsert({
      sessionId: 'sess-1',
      destRoot: 'D:\\mirror',
      syncedBytes: 3,
      metaSynced: false,
      state: 'pending',
      lastError: null,
      updatedAt: 1000
    })
    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(files),
      createSink: () => createFakeSink(),
      debounceMs: 500
    })

    coordinator.setOutputRoot('D:\\mirror')
    await vi.advanceTimersByTimeAsync(0)

    // Unchanged -- not blindly rebaselined to spoolSize (6) just because setOutputRoot was called again.
    expect(repo.get('sess-1')?.syncedBytes).toBe(3)
  })

  it('getStatusSummary only reports rows for the currently-configured root', () => {
    const repo = createFakeRepo()
    repo.upsert({
      sessionId: 'sess-old-root',
      destRoot: 'D:\\old-mirror',
      syncedBytes: 10,
      metaSynced: true,
      state: 'synced',
      lastError: null,
      updatedAt: 1000
    })
    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(new Map()),
      createSink: () => createFakeSink()
    })
    coordinator.setOutputRoot('D:\\new-mirror')

    expect(coordinator.getStatusSummary()).toEqual({ outputRoot: 'D:\\new-mirror', entries: [] })
  })
})
