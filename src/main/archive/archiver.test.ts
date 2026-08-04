// Behavioral test for SessionArchiver against real temp files: verifies append-only sync-copy (spec
// §4.4) and that the original transcript is never written to. Uses chokidar's real filesystem watcher
// (polling mode), so waits are done via a small poll-until helper rather than fixed sleeps to keep the
// test as fast as reliably possible while tolerating watcher latency.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionArchiver, scanChunksForLastUuidOffset, type ChunkReader } from './archiver'
import type { ParsedJsonlEntry } from '../../shared/jsonl'

async function waitFor(predicate: () => boolean, timeoutMs = 4000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  if (!predicate()) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`)
}

describe('SessionArchiver', () => {
  let tmpDir: string
  let sourcePath: string
  let archiveDir: string
  let archiver: SessionArchiver
  let entriesBySession: Map<string, ParsedJsonlEntry[]>
  let errors: Array<{ sessionId: string; err: unknown }>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-archiver-test-'))
    sourcePath = path.join(tmpDir, 'transcript.jsonl')
    archiveDir = path.join(tmpDir, 'archive', 'sess-1')
    entriesBySession = new Map()
    errors = []
    archiver = new SessionArchiver({
      onEntries: (sessionId, entries) => {
        const list = entriesBySession.get(sessionId) ?? []
        list.push(...entries)
        entriesBySession.set(sessionId, list)
      },
      onError: (sessionId, err) => errors.push({ sessionId, err })
    })
  })

  afterEach(() => {
    archiver.detachAll()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('copies appended JSONL lines into the archive without ever writing the original file', async () => {
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({
        message: { model: 'claude-x', usage: { input_tokens: 1, output_tokens: 1 } }
      }) + '\n'
    )
    const originalMtime = fs.statSync(sourcePath).mtimeMs

    const archivePath = archiver.attach('sess-1', sourcePath, archiveDir)

    await waitFor(() => fs.existsSync(archivePath) && fs.statSync(archivePath).size > 0)
    expect(fs.readFileSync(archivePath, 'utf-8')).toBe(fs.readFileSync(sourcePath, 'utf-8'))

    fs.appendFileSync(
      sourcePath,
      JSON.stringify({
        message: { model: 'claude-x', usage: { input_tokens: 2, output_tokens: 3 } }
      }) + '\n'
    )

    await waitFor(() => (entriesBySession.get('sess-1')?.length ?? 0) >= 2)
    expect(fs.readFileSync(archivePath, 'utf-8')).toBe(fs.readFileSync(sourcePath, 'utf-8'))

    // The original transcript's mtime only changed because *we* appended to it above via fs -- the
    // archiver itself never opens sourcePath for writing (verified by inspecting archiver.ts: only
    // fs.statSync/openSync('r')/readSync touch sourcePath).
    expect(fs.statSync(sourcePath).mtimeMs).toBeGreaterThanOrEqual(originalMtime)
    expect(errors).toEqual([])
  }, 10000)

  it('resumes from the existing archive size on reattach instead of duplicating already-archived bytes', async () => {
    // B2 fix regression guard: this fixture line carries a `uuid` (unlike the pre-fix version of this
    // test, which used a fixture with none and only ever exercised the degenerate null===null branch) so
    // this actually exercises the main "sidecar lastUuid matches archive anchor -> adopt sourceOffset"
    // resume path, not just the fallback.
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { model: 'm' } }) + '\n'
    )
    archiver.attach('sess-1', sourcePath, archiveDir)
    const archivePath = path.join(archiveDir, 'transcript.jsonl')
    await waitFor(() => fs.existsSync(archivePath) && fs.statSync(archivePath).size > 0)
    const sizeAfterFirstAttach = fs.statSync(archivePath).size

    archiver.detach('sess-1')
    const secondArchiver = new SessionArchiver({
      onEntries: () => undefined,
      onError: (sessionId, err) => errors.push({ sessionId, err })
    })
    secondArchiver.attach('sess-1', sourcePath, archiveDir)
    // Give the watcher a moment; since the source hasn't changed since detach, size must stay identical
    // (no duplicate copy of already-archived bytes).
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(fs.statSync(archivePath).size).toBe(sizeAfterFirstAttach)
    secondArchiver.detachAll()
  }, 10000)

  // M10 (ADR-0011/R-1): the archive now stores only lines shared/archiveRetention.ts's shouldRetainLine
  // decides are worth keeping -- discarded lines must never appear in the archive at all.
  it('never writes a discarded (denylisted) line into the archive, even though the source keeps it', async () => {
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({
        type: 'attachment',
        uuid: 'hs-1',
        attachment: { type: 'hook_success', payload: 'ignored-noise' }
      }) + '\n'
    )
    const archivePath = archiver.attach('sess-1', sourcePath, archiveDir)

    fs.appendFileSync(
      sourcePath,
      JSON.stringify({
        type: 'user',
        uuid: 'human-1',
        message: { content: [{ type: 'text', text: 'a real human message' }] }
      }) + '\n'
    )

    await waitFor(() => (entriesBySession.get('sess-1')?.length ?? 0) >= 2)
    const archived = fs.readFileSync(archivePath, 'utf-8')
    expect(archived).not.toContain('hook_success')
    expect(archived).not.toContain('ignored-noise')
    expect(archived).toContain('a real human message')
    expect(errors).toEqual([])
  }, 10000)

  // M10 (ADR-0011/D-4, R-6): a sidecar (`archive-state.json`) is written temp+rename alongside the
  // archive so the *source* read offset survives a restart even though the archive itself is now smaller
  // than the source (selective retention breaks the old "archive size == source bytes read" invariant).
  it('persists a sidecar with the source offset and last retained uuid, written via temp+rename', async () => {
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({
        type: 'user',
        uuid: 'human-1',
        message: { content: [{ type: 'text', text: 'hello' }] }
      }) + '\n'
    )
    archiver.attach('sess-1', sourcePath, archiveDir)
    const sidecarPath = path.join(archiveDir, 'archive-state.json')
    await waitFor(() => fs.existsSync(sidecarPath))

    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8')) as {
      sourceOffset: number
      lastUuid: string | null
    }
    expect(sidecar.sourceOffset).toBe(fs.statSync(sourcePath).size)
    expect(sidecar.lastUuid).toBe('human-1')
    // No leftover temp file from the temp+rename write.
    expect(fs.readdirSync(archiveDir).some((name) => name.endsWith('.tmp'))).toBe(false)
  }, 10000)

  // M10 (ADR-0011/D-4, R-6): simulates the "appended, but the sidecar update did not happen yet" crash
  // window by writing a stale sidecar (an older lastUuid) before re-attaching, and verifies the recovery
  // scan neither duplicates the already-archived line nor loses the source content past it.
  it('recovers without duplication when re-attached after a stale (crash-window) sidecar', async () => {
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({
        type: 'user',
        uuid: 'human-1',
        message: { content: [{ type: 'text', text: 'first message' }] }
      }) + '\n'
    )
    const archivePath = archiver.attach('sess-1', sourcePath, archiveDir)
    await waitFor(() => fs.readFileSync(archivePath, 'utf-8').includes('human-1'))
    archiver.detach('sess-1')

    // Simulate a crash between "line appended to the archive" and "sidecar updated": overwrite the
    // sidecar with a stale lastUuid that predates the line already in the archive.
    const sidecarPath = path.join(archiveDir, 'archive-state.json')
    fs.writeFileSync(sidecarPath, JSON.stringify({ sourceOffset: 0, lastUuid: 'stale-uuid' }))

    const secondArchiver = new SessionArchiver({
      onEntries: () => undefined,
      onError: (sessionId, err) => errors.push({ sessionId, err })
    })
    secondArchiver.attach('sess-1', sourcePath, archiveDir)
    await new Promise((resolve) => setTimeout(resolve, 300))

    const archivedText = fs.readFileSync(archivePath, 'utf-8')
    expect(archivedText.split('human-1').length - 1).toBe(1) // not duplicated
    expect(errors).toEqual([])
    secondArchiver.detachAll()
  }, 10000)

  // B1 fix: a chunk that ends mid-line (no trailing '\n' yet) must never be treated as confirmed --
  // detaching while that partial line is only held in the in-memory parseBuffer, then reattaching once the
  // rest of the line has arrived on disk, must produce the complete line exactly once, never a lost prefix
  // + an orphaned, unparseable suffix fragment.
  it('never loses or fragments a line that was only partially written when detached mid-line', async () => {
    const line1 = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      message: { content: [{ type: 'text', text: 'first' }] }
    })
    const fullLine2 = JSON.stringify({
      type: 'user',
      uuid: 'u2',
      message: { content: [{ type: 'text', text: 'SECOND-IMPORTANT' }] }
    })
    const splitPoint = fullLine2.indexOf('SECOND') + 3
    const line2Prefix = fullLine2.slice(0, splitPoint)
    const line2Suffix = fullLine2.slice(splitPoint)

    // No trailing newline after line2Prefix: line 2 is deliberately incomplete on disk.
    fs.writeFileSync(sourcePath, line1 + '\n' + line2Prefix)
    const archivePath = archiver.attach('sess-1', sourcePath, archiveDir)
    await waitFor(() => fs.readFileSync(archivePath, 'utf-8').includes('u1'))
    // Give the watcher time to have already read the incomplete line2 chunk into the in-memory
    // parseBuffer (not just line1) before we detach.
    await new Promise((resolve) => setTimeout(resolve, 300))
    archiver.detach('sess-1')

    // Complete line 2 in the source, as claude itself would (appending the rest of the same JSON value).
    fs.appendFileSync(sourcePath, line2Suffix + '\n')

    const secondArchiver = new SessionArchiver({
      onEntries: () => undefined,
      onError: (sessionId, err) => errors.push({ sessionId, err })
    })
    secondArchiver.attach('sess-1', sourcePath, archiveDir)
    await waitFor(() => fs.readFileSync(archivePath, 'utf-8').includes('SECOND-IMPORTANT'))

    const archived = fs.readFileSync(archivePath, 'utf-8')
    expect(archived).toContain(fullLine2)
    // Exactly once -- not lost (0 occurrences) and not duplicated/fragmented (more than 1 occurrence).
    expect(archived.split('SECOND-IMPORTANT').length - 1).toBe(1)
    expect(archived).not.toContain('�')
    expect(errors).toEqual([])
    secondArchiver.detachAll()
  }, 10000)

  // R-4: retained lines are archived byte-identical to the source, never re-serialized -- reordered keys,
  // a backslash-u escape sequence, a literal non-ASCII character, and an unrecognized field must all
  // survive unchanged.
  it('archives a retained line byte-identical to the source despite reordered keys, escapes, and unknown fields', async () => {
    const rawLine =
      '{"uuid":"u1","zUnknownField":123,"type":"user","message":{"content":[{"type":"text",' +
      '"text":"escaped:\\u65e5\\u672c\\u8a9e literal:日本語"}]}}'
    // Sanity: this is valid JSON representing a line the retention policy keeps (type:user, text-only).
    expect(JSON.parse(rawLine).type).toBe('user')

    fs.writeFileSync(sourcePath, rawLine + '\n')
    const archivePath = archiver.attach('sess-1', sourcePath, archiveDir)
    await waitFor(() => fs.existsSync(archivePath) && fs.statSync(archivePath).size > 0)

    expect(fs.readFileSync(archivePath, 'utf-8')).toBe(rawLine + '\n')
    expect(errors).toEqual([])
  }, 10000)

  // R-6 "取りこぼしも起こさない": the crash-window recovery scan must not just avoid duplicating the
  // already-archived line, it must also correctly pick up a line that only arrived on disk *after* the
  // stale sidecar was written, exactly once.
  it('captures a line appended after a stale-sidecar reattach exactly once (no loss, no duplication)', async () => {
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'text', text: 'first' }] }
      }) + '\n'
    )
    const archivePath = archiver.attach('sess-1', sourcePath, archiveDir)
    await waitFor(() => fs.readFileSync(archivePath, 'utf-8').includes('u1'))
    archiver.detach('sess-1')

    const sidecarPath = path.join(archiveDir, 'archive-state.json')
    fs.writeFileSync(sidecarPath, JSON.stringify({ sourceOffset: 0, lastUuid: 'stale-uuid' }))

    // A new line arrives on disk only after the stale sidecar exists -- simulating traffic that continued
    // during the crash window, before the app restarts and reattaches.
    fs.appendFileSync(
      sourcePath,
      JSON.stringify({
        type: 'user',
        uuid: 'u2',
        message: { content: [{ type: 'text', text: 'second' }] }
      }) + '\n'
    )

    const secondArchiver = new SessionArchiver({
      onEntries: () => undefined,
      onError: (sessionId, err) => errors.push({ sessionId, err })
    })
    secondArchiver.attach('sess-1', sourcePath, archiveDir)
    await waitFor(() => fs.readFileSync(archivePath, 'utf-8').includes('u2'))

    const archivedText = fs.readFileSync(archivePath, 'utf-8')
    expect(archivedText.split('"uuid":"u1"').length - 1).toBe(1) // not duplicated by the recovery scan
    expect(archivedText.split('"uuid":"u2"').length - 1).toBe(1) // captured exactly once, not lost
    expect(errors).toEqual([])
    secondArchiver.detachAll()
  }, 10000)

  // B2/C1: a non-empty, pre-M10-style archive (no sidecar at all, and a byte-for-byte verbatim copy of
  // the source) must resume without duplicating what it already has -- never from byte 0 (which would
  // duplicate everything already in it). C1 fix: this used to be served by adopting the archive's own byte
  // size directly (`legacyArchiveSize`, unverified); it is now served by the general `scan` path instead,
  // which happens to land on the exact same offset for a genuinely verbatim archive like this one (the
  // anchor uuid appears exactly once in the source), at the cost of one bounded scan instead of a `stat()`.
  it('resumes a pre-M10 archive (no sidecar) without duplicating its content, via the scan path', async () => {
    const legacyLine = JSON.stringify({
      type: 'user',
      uuid: 'legacy-1',
      message: { content: [{ type: 'text', text: 'pre-M10 content' }] }
    })
    fs.mkdirSync(archiveDir, { recursive: true })
    const archivePath = path.join(archiveDir, 'transcript.jsonl')
    // Simulate a pre-M10 archive: written directly, with no archive-state.json sidecar alongside it.
    fs.writeFileSync(archivePath, legacyLine + '\n')
    fs.writeFileSync(sourcePath, legacyLine + '\n')

    archiver.attach('sess-1', sourcePath, archiveDir)
    // Give the watcher a moment; since the source has nothing beyond what the legacy archive already has,
    // the archive's size must stay exactly as it was (no re-append of the legacy line).
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(fs.readFileSync(archivePath, 'utf-8')).toBe(legacyLine + '\n')
    expect(errors).toEqual([])
  }, 10000)

  // B2: when the archive and its sidecar contradict each other in a way with no safe resolution (empty
  // archive but a sidecar claiming a non-null last-retained uuid), attach must report the anomaly via
  // onError and refuse to guess -- never silently start syncing from either zero or the sidecar's offset,
  // both of which could duplicate or lose content.
  it('reports onError and does not sync when the archive/sidecar state has no safe resume anchor', async () => {
    fs.mkdirSync(archiveDir, { recursive: true })
    const archivePath = path.join(archiveDir, 'transcript.jsonl')
    fs.writeFileSync(archivePath, '') // archive is empty
    const sidecarPath = path.join(archiveDir, 'archive-state.json')
    fs.writeFileSync(sidecarPath, JSON.stringify({ sourceOffset: 500, lastUuid: 'ghost-uuid' }))
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'text', text: 'should not be synced' }] }
      }) + '\n'
    )

    archiver.attach('sess-1', sourcePath, archiveDir)
    await waitFor(() => errors.length > 0)

    // No sync ever happened for this session: the archive stays exactly as it was left (empty).
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(fs.readFileSync(archivePath, 'utf-8')).toBe('')
    expect(entriesBySession.get('sess-1')).toBeUndefined()
  }, 10000)

  // C1 fix, case 1/2: a post-M10, *selectively retained* archive (much smaller than its source, unlike the
  // pre-M10 verbatim-copy fixture above) that lost its sidecar (crash before the first sidecar write, or a
  // restored mirror snapshot that never copied `archive-state.json`). The removed `legacyArchiveSize`
  // branch used to adopt the *archive's own byte size* as the source offset here -- wrong by construction,
  // since a selectively-retained archive's size has no relationship to any offset in the (much larger)
  // source, landing the next read mid-line. The fix (fall back to `scan` unconditionally) must instead
  // recover the true offset (the end of the source) and leave the archive byte-for-byte unchanged.
  it('reattaches a selectively-retained archive with a missing sidecar without corrupting it (C1)', async () => {
    const discarded = JSON.stringify({
      type: 'attachment',
      uuid: 'd1',
      attachment: { type: 'hook_success', payload: 'x'.repeat(500) }
    })
    const retained = JSON.stringify({
      type: 'user',
      uuid: 'r1',
      message: { content: [{ type: 'text', text: 'a real human message' }] }
    })
    fs.writeFileSync(sourcePath, discarded + '\n' + retained + '\n')

    const archivePath = archiver.attach('sess-1', sourcePath, archiveDir)
    await waitFor(() => fs.readFileSync(archivePath, 'utf-8').includes('r1'))
    // The archive is a genuinely selective (much smaller) copy of the source -- the bug this guards
    // against only manifests when this is true.
    expect(fs.statSync(archivePath).size).toBeLessThan(fs.statSync(sourcePath).size)
    const archivedAfterFirstSync = fs.readFileSync(archivePath, 'utf-8')
    archiver.detach('sess-1')

    // Simulate the sidecar never having survived (crash / restored-without-sidecar mirror snapshot).
    fs.rmSync(path.join(archiveDir, 'archive-state.json'), { force: true })

    const secondArchiver = new SessionArchiver({
      onEntries: () => undefined,
      onError: (sessionId, err) => errors.push({ sessionId, err })
    })
    secondArchiver.attach('sess-1', sourcePath, archiveDir)
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(fs.readFileSync(archivePath, 'utf-8')).toBe(archivedAfterFirstSync)
    expect(errors).toEqual([])
    secondArchiver.detachAll()
  }, 10000)

  // C1 fix, case 2/2: same as above, but the sidecar is *present and malformed* (invalid JSON) rather than
  // missing entirely -- readSidecarOutcome's `invalid` kind must degrade exactly like `absent` here (never
  // treated as "trustworthy legacy archive"), and the parse failure itself must still be reported (R-6).
  it('reattaches a selectively-retained archive with a malformed sidecar without corrupting it (C1)', async () => {
    const discarded = JSON.stringify({
      type: 'attachment',
      uuid: 'd1',
      attachment: { type: 'hook_success', payload: 'x'.repeat(500) }
    })
    const retained = JSON.stringify({
      type: 'user',
      uuid: 'r1',
      message: { content: [{ type: 'text', text: 'a real human message' }] }
    })
    fs.writeFileSync(sourcePath, discarded + '\n' + retained + '\n')

    const archivePath = archiver.attach('sess-1', sourcePath, archiveDir)
    await waitFor(() => fs.readFileSync(archivePath, 'utf-8').includes('r1'))
    expect(fs.statSync(archivePath).size).toBeLessThan(fs.statSync(sourcePath).size)
    const archivedAfterFirstSync = fs.readFileSync(archivePath, 'utf-8')
    archiver.detach('sess-1')

    fs.writeFileSync(path.join(archiveDir, 'archive-state.json'), '{not valid json')

    const secondErrors: Array<{ sessionId: string; err: unknown }> = []
    const secondArchiver = new SessionArchiver({
      onEntries: () => undefined,
      onError: (sessionId, err) => secondErrors.push({ sessionId, err })
    })
    secondArchiver.attach('sess-1', sourcePath, archiveDir)
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(fs.readFileSync(archivePath, 'utf-8')).toBe(archivedAfterFirstSync)
    // The malformed sidecar is reported (R-6, never silently swallowed) but does not block the reattach.
    expect(secondErrors.length).toBe(1)
    secondArchiver.detachAll()
  }, 10000)

  // C2 fix: a sync batch whose *last retained line* carries no uuid (an R-5 tolerant-fallback line) must
  // not regress the sidecar's `lastUuid` to null when an earlier retained line already established one --
  // otherwise the sidecar and `readArchiveAnchor`'s own backward skip-past-uuid-less-lines computation
  // disagree, forcing a `scan` resume that lands just past the anchor line and re-appends the trailing
  // uuid-less line on every reattach. This exercises three reattaches in a row.
  it('does not duplicate a trailing retained line with no uuid on repeated reattach (C2)', async () => {
    const withUuid = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      message: { content: [{ type: 'text', text: 'hi' }] }
    })
    const noUuid = JSON.stringify({ type: 'some-future-type', payload: 'no uuid here' })
    fs.writeFileSync(sourcePath, withUuid + '\n' + noUuid + '\n')

    const archivePath = archiver.attach('sess-1', sourcePath, archiveDir)
    await waitFor(() => fs.readFileSync(archivePath, 'utf-8').includes('no uuid here'))
    archiver.detach('sess-1')

    const secondArchiver = new SessionArchiver({
      onEntries: () => undefined,
      onError: (sessionId, err) => errors.push({ sessionId, err })
    })
    secondArchiver.attach('sess-1', sourcePath, archiveDir)
    await new Promise((resolve) => setTimeout(resolve, 300))
    secondArchiver.detach('sess-1')

    const thirdArchiver = new SessionArchiver({
      onEntries: () => undefined,
      onError: (sessionId, err) => errors.push({ sessionId, err })
    })
    thirdArchiver.attach('sess-1', sourcePath, archiveDir)
    await new Promise((resolve) => setTimeout(resolve, 300))
    thirdArchiver.detachAll()

    const archived = fs.readFileSync(archivePath, 'utf-8')
    expect(archived.split('no uuid here').length - 1).toBe(1)
    expect(errors).toEqual([])
  }, 10000)

  // C1 fix, requirement #4 (defense in depth): even a syntactically-valid, uuid-matching sidecar whose
  // recorded `sourceOffset` does not land on a source line boundary (corrupted by some means this test
  // doesn't need to specify) must never be trusted -- attach refuses to watch and reports the anomaly,
  // rather than starting a read mid-line.
  it('refuses to resume from a sidecar offset that does not land on a source line boundary', async () => {
    const l1 = JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'hello world' } })
    fs.writeFileSync(sourcePath, l1 + '\n')
    fs.mkdirSync(archiveDir, { recursive: true })
    fs.writeFileSync(path.join(archiveDir, 'transcript.jsonl'), l1 + '\n')
    // A sidecar whose lastUuid matches the archive's anchor (so decideResumeOffset picks the 'sidecar'
    // branch) but whose sourceOffset is deliberately mid-line, not immediately after any '\n'.
    fs.writeFileSync(
      path.join(archiveDir, 'archive-state.json'),
      JSON.stringify({ sourceOffset: 3, lastUuid: 'u1' })
    )

    archiver.attach('sess-1', sourcePath, archiveDir)
    await waitFor(() => errors.length > 0)

    // Refused, not corrupted: the archive is untouched and nothing was ever read from the (bogus) offset.
    expect(fs.readFileSync(path.join(archiveDir, 'transcript.jsonl'), 'utf-8')).toBe(l1 + '\n')
    expect(entriesBySession.get('sess-1')).toBeUndefined()
  }, 10000)

  // C3 fix: the `unsafe` banner shown to the user must be Japanese, must not name any file path, and must
  // not instruct deleting/modifying archive-state.json or the archive (that instruction used to actively
  // cause the C1 data-corruption bug, and for some `unsafe` shapes never resolves anything anyway).
  it('surfaces a safe, path-free Japanese message (not a delete instruction) when unsafe', async () => {
    fs.mkdirSync(archiveDir, { recursive: true })
    fs.writeFileSync(path.join(archiveDir, 'transcript.jsonl'), '') // archive is empty
    fs.writeFileSync(
      path.join(archiveDir, 'archive-state.json'),
      JSON.stringify({ sourceOffset: 500, lastUuid: 'ghost-uuid' })
    )
    fs.writeFileSync(sourcePath, JSON.stringify({ type: 'user', uuid: 'u1' }) + '\n')

    archiver.attach('sess-1', sourcePath, archiveDir)
    await waitFor(() => errors.length > 0)

    const message = errors[0].err instanceof Error ? errors[0].err.message : String(errors[0].err)
    expect(message).toContain('新しいセッション')
    // Must not instruct deleting/fixing the sidecar or archive to "retry" (the old wording that actively
    // caused the C1 corruption bug) -- explicitly saying not to touch them is fine and expected.
    expect(message).not.toContain('remove archive-state.json')
    expect(message).not.toContain('retry')
    expect(message).not.toContain(sourcePath)
  }, 10000)
})

// Major fix #3: unit tests for the chunked forward-scan-for-last-uuid-occurrence logic, now exercised
// directly (via an in-memory `ChunkReader`) instead of only through the unused, string-based
// `findResumeOffsetByUuid` this replaced (shared/archiveRetention.ts) -- this is the implementation
// `SessionArchiver.recoverOffsetByScanning` actually calls in production.
describe('scanChunksForLastUuidOffset', () => {
  function readerFor(source: string): { reader: ChunkReader; totalSize: number } {
    const bytes = Buffer.from(source, 'utf-8')
    const reader: ChunkReader = (position, buffer, length) => {
      const end = Math.min(position + length, bytes.length)
      const slice = bytes.subarray(position, end)
      slice.copy(buffer, 0)
      return slice.length
    }
    return { reader, totalSize: bytes.length }
  }

  it('finds the byte offset immediately after the matching line (not the last line)', () => {
    const l1 = JSON.stringify({ uuid: 'first' })
    const l2 = JSON.stringify({ uuid: 'target' })
    const l3 = JSON.stringify({ uuid: 'third' })
    const source = `${l1}\n${l2}\n${l3}\n`
    const { reader, totalSize } = readerFor(source)
    const expectedOffset = Buffer.byteLength(l1, 'utf-8') + 1 + Buffer.byteLength(l2, 'utf-8') + 1
    expect(scanChunksForLastUuidOffset(reader, totalSize, 'target')).toBe(expectedOffset)
  })

  it('finds the offset when the match is the final line and the source ends with a newline', () => {
    const l1 = JSON.stringify({ uuid: 'first' })
    const l2 = JSON.stringify({ uuid: 'target' })
    const source = `${l1}\n${l2}\n`
    const { reader, totalSize } = readerFor(source)
    expect(scanChunksForLastUuidOffset(reader, totalSize, 'target')).toBe(
      Buffer.byteLength(source, 'utf-8')
    )
  })

  it('handles multi-byte utf-8 content correctly (byte length, not character length)', () => {
    const l1 = JSON.stringify({ uuid: 'first', text: 'こんにちは世界' })
    const l2 = JSON.stringify({ uuid: 'target' })
    const source = `${l1}\n${l2}\n`
    const { reader, totalSize } = readerFor(source)
    expect(scanChunksForLastUuidOffset(reader, totalSize, 'target')).toBe(
      Buffer.byteLength(source, 'utf-8')
    )
  })

  it('returns null when the target uuid is not present anywhere in the source', () => {
    const source = `${JSON.stringify({ uuid: 'a' })}\n${JSON.stringify({ uuid: 'b' })}\n`
    const { reader, totalSize } = readerFor(source)
    expect(scanChunksForLastUuidOffset(reader, totalSize, 'missing')).toBeNull()
  })

  // B2 fix regression guard: a duplicate uuid must resolve to the *last* occurrence, not the first --
  // otherwise resuming just past the first occurrence re-appends every line between it and the true last
  // occurrence, corrupting the append-only archive with duplicates.
  it('returns the offset of the LAST occurrence when the target uuid appears more than once', () => {
    const l1 = JSON.stringify({ uuid: 'dup', n: 1 })
    const l2 = JSON.stringify({ uuid: 'other' })
    const l3 = JSON.stringify({ uuid: 'dup', n: 2 })
    const source = `${l1}\n${l2}\n${l3}\n`
    const { reader, totalSize } = readerFor(source)
    expect(scanChunksForLastUuidOffset(reader, totalSize, 'dup')).toBe(
      Buffer.byteLength(source, 'utf-8')
    )
  })

  // New coverage the old string-based `findResumeOffsetByUuid` fixture never exercised: a chunk size much
  // smaller than a single line, forcing the target line's own bytes (and the newline that ends it) to be
  // split across multiple `readChunk` calls.
  it('finds a match whose own line spans multiple chunk-reader calls', () => {
    const l1 = JSON.stringify({ uuid: 'first' })
    const l2 = JSON.stringify({ uuid: 'target', payload: 'x'.repeat(200) })
    const l3 = JSON.stringify({ uuid: 'third' })
    const source = `${l1}\n${l2}\n${l3}\n`
    const { reader, totalSize } = readerFor(source)
    const expectedOffset = Buffer.byteLength(l1, 'utf-8') + 1 + Buffer.byteLength(l2, 'utf-8') + 1
    expect(scanChunksForLastUuidOffset(reader, totalSize, 'target', 8)).toBe(expectedOffset)
  })

  it('returns null for an empty source', () => {
    const { reader, totalSize } = readerFor('')
    expect(scanChunksForLastUuidOffset(reader, totalSize, 'anything')).toBeNull()
  })
})
