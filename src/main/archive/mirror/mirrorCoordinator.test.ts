// Behavioral tests for MirrorCoordinator against in-memory fakes (ArchiveMirrorRepoPort/SpoolReader/
// ArchiveSink) -- same rationale as sessionCoordinator.test.ts: no real SQLite/filesystem needed, and this
// keeps timer-driven behavior (debounce, retry backoff) deterministic under vi.useFakeTimers().
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MirrorCoordinator } from './mirrorCoordinator'
import type { ArchiveMirrorRepoPort, ArchiveMirrorRow } from '../../db/archiveMirrorRepo'
import type { BackfillProgressEvent } from '../../../shared/ipc'
import type { ArchiveSink } from './sink'
import type { SpoolReader } from './spoolReader'
import { UNRECOVERABLE_SYNCED_BYTES } from '../../../shared/mirrorPlan'

// ADR-0009: archive_mirror is keyed by (session_id, dest_root) -- the fake repo below mirrors that exactly
// (a composite-key Map) so these tests exercise the coordinator against the same lookup shape the real
// SQLite-backed repo (archiveMirrorRepo.ts) now has.
function compositeKey(sessionId: string, destRoot: string): string {
  // NOTE (M8, incidental hygiene fix): this previously embedded a literal raw NUL byte (0x00) directly in
  // the source file as the separator between the two parts -- functionally harmless (a NUL character
  // embedded in a JS string is perfectly valid at runtime, and no test session id ever contains one), but a
  // raw NUL byte in a *source file* trips several tools' binary-content heuristics (git diff, GNU diff),
  // which then refuse to show a normal text diff for this entire file -- a real problem for code review.
  // The standard `\0` escape sequence below produces the exact same runtime string value while keeping the
  // source file itself plain, unambiguous text.
  return `${sessionId}\0${destRoot}`
}

function createFakeRepo(): ArchiveMirrorRepoPort & { rows: Map<string, ArchiveMirrorRow> } {
  const rows = new Map<string, ArchiveMirrorRow>()
  return {
    rows,
    get: (sessionId, destRoot) => {
      const row = rows.get(compositeKey(sessionId, destRoot))
      return row ? { ...row } : null
    },
    upsert: (row) => rows.set(compositeKey(row.sessionId, row.destRoot), { ...row }),
    listAll: () => [...rows.values()].map((r) => ({ ...r })),
    listForDestRoot: (root) =>
      [...rows.values()].filter((r) => r.destRoot === root).map((r) => ({ ...r })),
    delete: (sessionId, destRoot) => {
      rows.delete(compositeKey(sessionId, destRoot))
    }
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
  failNextStat: boolean
  failNextReadPrefix: boolean
}

function createFakeSink(): FakeSink {
  const transcripts = new Map<string, string>()
  const metadata = new Map<string, string>()
  const sink: FakeSink = {
    transcripts,
    metadata,
    failNextAppend: false,
    failNextStat: false,
    failNextReadPrefix: false,
    statTranscript: async (id) => {
      if (sink.failNextStat) {
        sink.failNextStat = false
        throw new Error('simulated transient stat failure')
      }
      return transcripts.has(id) ? Buffer.byteLength(transcripts.get(id) as string, 'utf-8') : null
    },
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
      if (sink.failNextReadPrefix) {
        sink.failNextReadPrefix = false
        throw new Error('simulated transient read failure')
      }
      const current = transcripts.get(id) ?? ''
      return Buffer.from(current, 'utf-8').subarray(0, length)
    },
    deleteSession: async (id) => {
      transcripts.delete(id)
      metadata.delete(id)
    }
  }
  return sink
}

describe('MirrorCoordinator (spec §4.4.1, ADR-0008/ADR-0009)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Regression (startup race, observed in the field: 214 of 228 sessions sentinel-blocked in a single
  // startup at once). main/index.ts calls setOutputRoot(persistedRoot) and then recoverOnStartup()
  // back-to-back, so a session's rebaseline verification and its crash-recovery sync pass used to run
  // concurrently against the same row. rebaselineSession read the row *before* its (slow, network-drive)
  // sink.statTranscript await and then judged the destination's now-larger real size against that stale
  // `recordedSyncedBytes` -- computeResumeVerificationRange reads "destination bigger than recorded" as a
  // confirmed out-of-band modification and sentinel-blocks the row permanently, even though the sync pass
  // that grew the destination was this very coordinator doing exactly what it should.
  it('does not sentinel a healthy row when startup recovery syncs it while rebaseline is still verifying', async () => {
    const repo = createFakeRepo()
    const files = new Map<string, FakeSpoolFile>([
      // The spool grew while the app was down: 100 bytes were already mirrored, 50 are new.
      ['sess-1', { transcript: 'a'.repeat(150), metadata: null }]
    ])
    const sink = createFakeSink()
    sink.transcripts.set('sess-1', 'a'.repeat(100))
    repo.upsert({
      sessionId: 'sess-1',
      destRoot: '/out',
      syncedBytes: 100,
      metaSynced: true,
      state: 'synced',
      lastError: null,
      updatedAt: 1
    })

    // Holds rebaselineSession's own destination stat open until the recovery sync pass has finished,
    // reproducing the real ordering (a Google-Drive-backed root answers stat far slower than the 0ms
    // recovery timer).
    let releaseVerifyStat = (): void => {}
    const verifyStatGate = new Promise<void>((resolve) => {
      releaseVerifyStat = resolve
    })
    const realStat = sink.statTranscript
    let statCalls = 0
    sink.statTranscript = async (id): Promise<number | null> => {
      statCalls += 1
      if (statCalls === 1) await verifyStatGate
      return realStat(id)
    }

    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(files),
      createSink: () => sink
    })

    coordinator.setOutputRoot('/out')
    coordinator.recoverOnStartup()
    await vi.advanceTimersByTimeAsync(0)
    releaseVerifyStat()
    await vi.advanceTimersByTimeAsync(5000)

    const row = repo.get('sess-1', '/out')
    expect(row?.syncedBytes).not.toBe(UNRECOVERABLE_SYNCED_BYTES)
    expect(row?.state).toBe('synced')
    expect(row?.lastError).toBeNull()
    expect(sink.transcripts.get('sess-1')).toBe('a'.repeat(150))
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
    const row = repo.get('sess-1', 'D:\\mirror')
    expect(row?.state).toBe('synced')
    expect(row?.syncedBytes).toBe(6)
    expect(row?.metaSynced).toBe(true)
  })

  it('remirrorSession discards a diverged destination copy and re-copies the full spool from scratch', async () => {
    const repo = createFakeRepo()
    const sink = createFakeSink()
    const root = 'D:\\mirror'
    const fullSpool = 'AAAA\nBBBB\nCCCC\n'
    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(new Map([['sess-1', { transcript: fullSpool, metadata: '{"t":9}' }]])),
      createSink: () => sink
    })

    // Pre-existing bad state: a destination copy that diverged from the spool, plus a sentinel-blocked
    // error row (the sentinel makes setOutputRoot's rebaseline short-circuit, so it stays errored).
    sink.transcripts.set('sess-1', 'AAAA\nWRONG\n')
    repo.upsert({
      sessionId: 'sess-1',
      destRoot: root,
      syncedBytes: UNRECOVERABLE_SYNCED_BYTES,
      metaSynced: false,
      state: 'error',
      lastError: 'content mismatch',
      updatedAt: 0
    })
    coordinator.setOutputRoot(root)
    expect(repo.get('sess-1', root)?.state).toBe('error')

    await coordinator.remirrorSession('sess-1')

    // Destination now byte-for-byte equals the spool, and the row is healthy again.
    expect(sink.transcripts.get('sess-1')).toBe(fullSpool)
    expect(sink.metadata.get('sess-1')).toBe('{"t":9}')
    const row = repo.get('sess-1', root)
    expect(row?.state).toBe('synced')
    expect(row?.syncedBytes).toBe(Buffer.byteLength(fullSpool, 'utf-8'))
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

    const row = repo.get('sess-1', 'D:\\mirror')
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
    expect(repo.get('sess-1', 'D:\\mirror')?.state).toBe('error')

    // Retry fires automatically; the destination is no longer failing this time.
    await vi.advanceTimersByTimeAsync(2000)
    expect(repo.get('sess-1', 'D:\\mirror')?.state).toBe('synced')
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

    const row = repo.get('old-session', 'D:\\mirror')
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

  // ADR-0009 regression tests: switching the output root A -> B -> A back again. Unlike the M6 single-row
  // schema (spec §5 as shipped then), archive_mirror is now keyed by (session_id, dest_root) -- root A's
  // own progress row is untouched while mirroring is pointed at B, so switching back to A resumes exactly
  // where A itself left off, re-verified (not blindly trusted) against A's actual current content.
  describe('A -> B -> A output-root switch-back (per-root progress, ADR-0009)', () => {
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
      // resumes safely from there, and the row is left as-is (ADR-0009: no gratuitous rewrite on a
      // successful verification of an already-tracked root).
      coordinator.setOutputRoot('D:\\A')
      await vi.advanceTimersByTimeAsync(0)
      expect(repo.get('sess-1', 'D:\\A')?.state).toBe('synced')
      expect(repo.get('sess-1', 'D:\\A')?.syncedBytes).toBe(100)

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
      expect(repo.get('sess-1', 'D:\\A')?.state).toBe('synced')
    })

    // Regression test for the exact scenario that was a permanent safe-stop under the M6 single-row schema
    // (spec §5 as shipped then): A holds a *post-skip suffix* (its own history was skipped when A was first
    // configured, ADR-0008/D-4), not a full prefix from spool offset 0. ADR-0009's per-root row means A's
    // own recorded synced_bytes (which encodes exactly how much was skipped) survives the trip through B
    // untouched, so switching back to A can safely verify and resume -- this is the acceptance criterion
    // "M6 で permanent-block だったケースが resume に変わる" made concrete.
    it('resumes from A"s own recorded progress (post-skip suffix) instead of permanently blocking (ADR-0009 supersedes the M6 permanent-block)', async () => {
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
      // (spool[50:100]), not spool[0:50].
      files.set('sess-1', { transcript: 'p'.repeat(50), metadata: null })
      coordinator.setOutputRoot('D:\\A')
      await vi.advanceTimersByTimeAsync(0)
      expect(sinkA.transcripts.has('sess-1')).toBe(false)
      expect(repo.get('sess-1', 'D:\\A')?.syncedBytes).toBe(50) // skip-baseline: gap of 50 established

      files.set('sess-1', { transcript: 'p'.repeat(50) + 'q'.repeat(50), metadata: null })
      coordinator.onTranscriptAppended('sess-1')
      await vi.advanceTimersByTimeAsync(100)
      expect(sinkA.transcripts.get('sess-1')).toBe('q'.repeat(50)) // a suffix, not spool[0:50]
      expect(repo.get('sess-1', 'D:\\A')?.syncedBytes).toBe(100)

      // 2) Switch to B, grow further, switch back to A.
      coordinator.setOutputRoot('D:\\B')
      await vi.advanceTimersByTimeAsync(0)
      files.set('sess-1', {
        transcript: 'p'.repeat(50) + 'q'.repeat(50) + 'r'.repeat(50),
        metadata: null
      })
      coordinator.onTranscriptAppended('sess-1')
      await vi.advanceTimersByTimeAsync(100)
      expect(sinkB.transcripts.get('sess-1')).toBe('r'.repeat(50))

      coordinator.setOutputRoot('D:\\A')
      await vi.advanceTimersByTimeAsync(0)

      // 3) A's own row (syncedBytes=100, gap=50) survived B's visit untouched -- verification reads A's
      // actual 50 physical bytes ("q"*50) against spool[50:100] ("q"*50): a match. Resume succeeds -- no
      // permanent block, unlike the M6 single-row schema.
      expect(repo.get('sess-1', 'D:\\A')?.state).toBe('synced')
      expect(repo.get('sess-1', 'D:\\A')?.syncedBytes).toBe(100)
      expect(sinkA.transcripts.get('sess-1')).toBe('q'.repeat(50)) // untouched by the switch itself

      // 4) Further spool growth resumes correctly at A, producing the destination's full, uncorrupted
      // (minus the deliberately-skipped first 50 bytes) content -- the destination genuinely converges with
      // the spool suffix, no corruption.
      files.set('sess-1', {
        transcript: 'p'.repeat(50) + 'q'.repeat(50) + 'r'.repeat(50) + 's'.repeat(50),
        metadata: null
      })
      coordinator.onTranscriptAppended('sess-1')
      await vi.advanceTimersByTimeAsync(100)
      expect(sinkA.transcripts.get('sess-1')).toBe('q'.repeat(50) + 'r'.repeat(50) + 's'.repeat(50))
      expect(repo.get('sess-1', 'D:\\A')?.state).toBe('synced')
    })

    it('sentinel-blocks (state=error) when the destination was genuinely modified out-of-band while mirrored elsewhere', async () => {
      const repo = createFakeRepo()
      const files = new Map<string, FakeSpoolFile>([
        ['sess-1', { transcript: 'x'.repeat(100), metadata: null }]
      ])
      const sinkA = createFakeSink()
      const sinkB = createFakeSink()
      const sinks: Record<string, FakeSink> = { 'D:\\A': sinkA, 'D:\\B': sinkB }
      const coordinator = new MirrorCoordinator({
        repo,
        spool: createFakeSpool(files),
        createSink: (root) => sinks[root],
        debounceMs: 100
      })

      coordinator.setOutputRoot('D:\\A')
      await vi.advanceTimersByTimeAsync(0)
      files.set('sess-1', { transcript: 'x'.repeat(150), metadata: null })
      coordinator.onTranscriptAppended('sess-1')
      await vi.advanceTimersByTimeAsync(100)
      expect(sinkA.transcripts.get('sess-1')).toBe('x'.repeat(50))

      coordinator.setOutputRoot('D:\\B')
      await vi.advanceTimersByTimeAsync(0)

      // Out-of-band interference: something other than this app rewrites A's file while we are away.
      sinkA.transcripts.set('sess-1', 'TAMPERED-CONTENT-NOT-A-SPOOL-PREFIX'.padEnd(50, '!'))

      coordinator.setOutputRoot('D:\\A')
      await vi.advanceTimersByTimeAsync(0)

      expect(repo.get('sess-1', 'D:\\A')?.state).toBe('error')
      expect(repo.get('sess-1', 'D:\\A')?.lastError).toMatch(/一致しません/)
      // Never auto-appended to after the mismatch is detected.
      const tamperedContent = sinkA.transcripts.get('sess-1')
      files.set('sess-1', { transcript: 'x'.repeat(200), metadata: null })
      coordinator.onTranscriptAppended('sess-1')
      await vi.advanceTimersByTimeAsync(100)
      expect(sinkA.transcripts.get('sess-1')).toBe(tamperedContent)
    })
  })

  it('a transient I/O failure while verifying a resume is retried, not sentinel-blocked (ADR-0009 decision 4)', async () => {
    const repo = createFakeRepo()
    const files = new Map<string, FakeSpoolFile>([
      ['sess-1', { transcript: 'x'.repeat(50), metadata: null }]
    ])
    const sinkA = createFakeSink()
    const sinkB = createFakeSink()
    const sinks: Record<string, FakeSink> = { 'D:\\A': sinkA, 'D:\\B': sinkB }
    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(files),
      createSink: (root) => sinks[root],
      debounceMs: 100,
      baseRetryDelayMs: 1000,
      maxRetryDelayMs: 5000
    })

    coordinator.setOutputRoot('D:\\A')
    await vi.advanceTimersByTimeAsync(0)
    files.set('sess-1', { transcript: 'x'.repeat(100), metadata: null })
    coordinator.onTranscriptAppended('sess-1')
    await vi.advanceTimersByTimeAsync(100)
    expect(sinkA.transcripts.get('sess-1')).toBe('x'.repeat(50))

    coordinator.setOutputRoot('D:\\B')
    await vi.advanceTimersByTimeAsync(0)

    // Simulate A becoming briefly unreachable exactly during the resume-verification read.
    sinkA.failNextReadPrefix = true
    coordinator.setOutputRoot('D:\\A')
    await vi.advanceTimersByTimeAsync(0)

    const afterFailure = repo.get('sess-1', 'D:\\A')
    expect(afterFailure?.state).toBe('error')
    expect(afterFailure?.syncedBytes).toBe(100) // preserved, NOT the UNRECOVERABLE sentinel
    expect(afterFailure?.lastError).toMatch(/一時的/)

    // The failure was transient -- a retry (scheduled automatically) succeeds once the destination is
    // reachable again, resuming normally rather than staying permanently blocked.
    await vi.advanceTimersByTimeAsync(1000)
    expect(repo.get('sess-1', 'D:\\A')?.state).toBe('synced')
  })

  it('a sentinel-blocked row is never auto-retried and its diagnostic last_error is never overwritten (followups: no 60s backoff churn)', async () => {
    const repo = createFakeRepo()
    const files = new Map<string, FakeSpoolFile>([
      ['sess-1', { transcript: 'p'.repeat(50), metadata: null }]
    ])
    const sinkA = createFakeSink()
    const sinkB = createFakeSink()
    const sinks: Record<string, FakeSink> = { 'D:\\A': sinkA, 'D:\\B': sinkB }
    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(files),
      createSink: (root) => sinks[root],
      debounceMs: 100,
      baseRetryDelayMs: 1000,
      maxRetryDelayMs: 5000
    })

    coordinator.setOutputRoot('D:\\A')
    await vi.advanceTimersByTimeAsync(0)
    files.set('sess-1', { transcript: 'p'.repeat(50) + 'q'.repeat(50), metadata: null })
    coordinator.onTranscriptAppended('sess-1')
    await vi.advanceTimersByTimeAsync(100)

    coordinator.setOutputRoot('D:\\B')
    await vi.advanceTimersByTimeAsync(0)
    sinkA.transcripts.set('sess-1', 'not-a-genuine-prefix'.padEnd(50, '!'))
    coordinator.setOutputRoot('D:\\A')
    await vi.advanceTimersByTimeAsync(0)

    const sentinelRow = repo.get('sess-1', 'D:\\A')
    expect(sentinelRow?.state).toBe('error')
    const diagnostic = sentinelRow?.lastError
    expect(diagnostic).toMatch(/一致しません/)

    // Further activity must never re-arm a retry that clobbers the diagnostic or unblocks the sentinel.
    files.set('sess-1', { transcript: 'p'.repeat(200), metadata: null })
    coordinator.onTranscriptAppended('sess-1')
    await vi.advanceTimersByTimeAsync(60_000)

    const stillSentinel = repo.get('sess-1', 'D:\\A')
    expect(stillSentinel?.state).toBe('error')
    expect(stillSentinel?.lastError).toBe(diagnostic) // unchanged -- never overwritten by a retry pass
    expect(sinkA.transcripts.get('sess-1')).toBe('not-a-genuine-prefix'.padEnd(50, '!')) // untouched
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
    expect(repo.get('sess-1', 'D:\\mirror')?.syncedBytes).toBe(100)
    expect(sink.transcripts.has('sess-1')).toBe(false)

    // 2) 50 more bytes are appended post-config -- normal incremental sync mirrors *only* this new suffix
    // (spool[100:150]), landing at the destination as its first (and only) 50 real bytes.
    files.set('sess-1', { transcript: 'x'.repeat(100) + 'y'.repeat(50), metadata: null })
    coordinator.onTranscriptAppended('sess-1')
    await vi.advanceTimersByTimeAsync(100)
    expect(sink.transcripts.get('sess-1')).toBe('y'.repeat(50))
    expect(repo.get('sess-1', 'D:\\mirror')?.syncedBytes).toBe(150)

    // 3) Backfill must now refuse: naively resuming from destSize=50 would append spool[50:150] onto the
    // existing spool[100:150] already at the destination, corrupting it.
    const events: BackfillProgressEvent[] = []
    await coordinator.startBackfill((e) => events.push(e))

    expect(sink.transcripts.get('sess-1')).toBe('y'.repeat(50)) // untouched -- no corruption happened
    expect(repo.get('sess-1', 'D:\\mirror')?.state).toBe('error')
    expect(repo.get('sess-1', 'D:\\mirror')?.lastError).toMatch(/バックフィルできません/)
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

  // Followups (structure #2): backfill must not push a fresh getStatusSummary-triggering onStatusChanged
  // for every markSynced/recordError call during the loop (O(session-count) work per call, O(N^2) total
  // across N sessions) -- only one aggregate push once the whole backfill completes.
  it('startBackfill pushes onStatusChanged once (not once per session) regardless of session count', async () => {
    const repo = createFakeRepo()
    const files = new Map<string, FakeSpoolFile>(
      Array.from({ length: 5 }, (_, i) => [
        `sess-${i}`,
        { transcript: `history for session ${i}`, metadata: `{"i":${i}}` }
      ])
    )
    const sink = createFakeSink()
    let statusChangedCalls = 0
    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(files),
      createSink: () => sink,
      debounceMs: 100,
      onStatusChanged: () => {
        statusChangedCalls++
      }
    })
    coordinator.setOutputRoot('D:\\mirror')
    await vi.advanceTimersByTimeAsync(0)
    statusChangedCalls = 0 // reset: only interested in pushes made *during* the backfill call below

    await coordinator.startBackfill(() => {})

    expect(statusChangedCalls).toBe(1)
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
    expect(repo.get('sess-1', 'D:\\mirror')?.state).toBe('synced')
    expect(repo.get('sess-1', 'D:\\mirror')?.syncedBytes).toBe(6)
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
    // M8/D-1: the destination already genuinely holds the 3 bytes recorded (gap=0, a real prior partial
    // mirror) -- distinct from destSize=0, which M8's computeResumeVerificationRange change now refuses
    // outright (see the dedicated destSize=0 test immediately below this one) instead of optimistically
    // treating it as a trivial zero-length range.
    const sink = createFakeSink()
    sink.transcripts.set('sess-1', 'abc')
    const coordinator = new MirrorCoordinator({
      repo,
      spool: createFakeSpool(files),
      createSink: () => sink,
      debounceMs: 500
    })

    coordinator.setOutputRoot('D:\\mirror')
    await vi.advanceTimersByTimeAsync(0)

    // Unchanged -- not blindly rebaselined to spoolSize (6) just because setOutputRoot was called again.
    expect(repo.get('sess-1', 'D:\\mirror')?.syncedBytes).toBe(3)
    expect(repo.get('sess-1', 'D:\\mirror')?.state).toBe('pending')
  })

  // M8/D-1 (M7 followup "destSize=0 エッジ"): the exact integration-level counterpart of
  // computeResumeVerificationRange's own destSize=0/recordedSyncedBytes>0 unit test (mirrorPlan.test.ts) --
  // a tracked row whose destination has become physically empty (deleted out-of-band, or a destination
  // that was replaced) is sentinel-blocked (state='error', requiring an explicit backfill) instead of
  // rebaselineSession silently re-adopting offset 0 and letting ordinary sync recreate the file missing its
  // entire recorded prefix.
  it('rebaselineSession refuses (sentinel-blocks) a tracked row whose destination has become physically empty (destSize=0, recordedSyncedBytes>0, suspected external deletion)', async () => {
    const repo = createFakeRepo()
    const files = new Map<string, FakeSpoolFile>([['sess-1', { transcript: 'abcdef', metadata: null }]])
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
      // Fresh, empty sink -- the destination that previously held the recorded 3 bytes is now gone.
      createSink: () => createFakeSink(),
      debounceMs: 500
    })

    coordinator.setOutputRoot('D:\\mirror')
    await vi.advanceTimersByTimeAsync(0)

    const row = repo.get('sess-1', 'D:\\mirror')
    expect(row?.state).toBe('error')
    expect(row?.lastError).toMatch(/バックフィル|削除/)
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
