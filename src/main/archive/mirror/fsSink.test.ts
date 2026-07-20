// Exercises createFsSink/probeWritable against a real scratch directory on disk (plain node:fs, no
// Electron/better-sqlite3 needed -- unlike sessionRepo.ts's native-module constraint, this module's only
// dependency is node:fs, so it can be tested directly rather than through a fake).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFsSink, probeWritable } from './fsSink'

describe('createFsSink (M6, ADR-0008/D-3/D-5)', () => {
  let destRoot: string

  beforeEach(() => {
    destRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-fssink-test-'))
  })

  afterEach(() => {
    fs.rmSync(destRoot, { recursive: true, force: true })
  })

  it('statTranscript returns null when the destination file does not exist yet', async () => {
    const sink = createFsSink(destRoot)
    await expect(sink.statTranscript('sess-1')).resolves.toBeNull()
  })

  it('appendTranscript creates the session dir + file, and statTranscript reflects the new size', async () => {
    const sink = createFsSink(destRoot)
    await sink.appendTranscript('sess-1', 0, Buffer.from('{"a":1}\n'))
    await expect(sink.statTranscript('sess-1')).resolves.toBe(8)
    const written = fs.readFileSync(path.join(destRoot, 'sess-1', 'transcript.jsonl'), 'utf-8')
    expect(written).toBe('{"a":1}\n')
  })

  it('a second in-sequence append is accepted and appended (never overwrites the first)', async () => {
    const sink = createFsSink(destRoot)
    await sink.appendTranscript('sess-1', 0, Buffer.from('line1\n'))
    await sink.appendTranscript('sess-1', 6, Buffer.from('line2\n'))
    const written = fs.readFileSync(path.join(destRoot, 'sess-1', 'transcript.jsonl'), 'utf-8')
    expect(written).toBe('line1\nline2\n')
  })

  it('refuses (throws) an append whose offset does not match the destination file size (append-only guard)', async () => {
    const sink = createFsSink(destRoot)
    await sink.appendTranscript('sess-1', 0, Buffer.from('line1\n'))
    await expect(sink.appendTranscript('sess-1', 0, Buffer.from('conflicting\n'))).rejects.toThrow(
      /refusing to write/
    )
    // The original content must be untouched -- no overwrite happened.
    const written = fs.readFileSync(path.join(destRoot, 'sess-1', 'transcript.jsonl'), 'utf-8')
    expect(written).toBe('line1\n')
  })

  it('refuses an append when offset is ahead of the actual destination size (would leave a gap)', async () => {
    const sink = createFsSink(destRoot)
    await expect(sink.appendTranscript('sess-1', 10, Buffer.from('x'))).rejects.toThrow(
      /refusing to write/
    )
  })

  it('writeMetadata creates/overwrites metadata.json at the destination', async () => {
    const sink = createFsSink(destRoot)
    await sink.writeMetadata('sess-1', '{"title":"v1"}')
    expect(fs.readFileSync(path.join(destRoot, 'sess-1', 'metadata.json'), 'utf-8')).toBe(
      '{"title":"v1"}'
    )
    await sink.writeMetadata('sess-1', '{"title":"v2"}')
    expect(fs.readFileSync(path.join(destRoot, 'sess-1', 'metadata.json'), 'utf-8')).toBe(
      '{"title":"v2"}'
    )
  })

  it('readTranscriptPrefix reads back exactly the requested leading bytes', async () => {
    const sink = createFsSink(destRoot)
    await sink.appendTranscript('sess-1', 0, Buffer.from('abcdefghij'))
    await expect(sink.readTranscriptPrefix('sess-1', 4)).resolves.toEqual(Buffer.from('abcd'))
    await expect(sink.readTranscriptPrefix('sess-1', 0)).resolves.toEqual(Buffer.alloc(0))
  })

  // M7 followup (bytesRead validation): the original tests above only ever exercised length=4 (out of a
  // 10-byte file) and length=0 -- both happen to be safely within the file's real size. A mid-length read
  // (still safe) and a too-long read (unsafe -- must be caught, not silently zero-padded) are added here.
  it('readTranscriptPrefix reads a mid-length prefix shorter than the full file', async () => {
    const sink = createFsSink(destRoot)
    await sink.appendTranscript('sess-1', 0, Buffer.from('abcdefghij')) // 10 bytes
    await expect(sink.readTranscriptPrefix('sess-1', 7)).resolves.toEqual(Buffer.from('abcdefg'))
  })

  it('readTranscriptPrefix throws on a short read (requested length exceeds the actual file size)', async () => {
    const sink = createFsSink(destRoot)
    await sink.appendTranscript('sess-1', 0, Buffer.from('abcde')) // 5 bytes
    await expect(sink.readTranscriptPrefix('sess-1', 10)).rejects.toThrow(/short read/)
  })

  it('rejects a session id that would escape the destination root (path traversal defense-in-depth)', async () => {
    const sink = createFsSink(destRoot)
    await expect(sink.appendTranscript('../../evil', 0, Buffer.from('x'))).rejects.toThrow(
      /escapes the configured output root/
    )
  })
})

describe('probeWritable (M6, ADR-0008/D-5)', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-probe-test-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('resolves ok for a writable directory, and leaves no probe file behind', async () => {
    await expect(probeWritable(root)).resolves.toEqual({ ok: true })
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('creates the directory if it does not exist yet, then probes it', async () => {
    const nested = path.join(root, 'a', 'b', 'c')
    await expect(probeWritable(nested)).resolves.toEqual({ ok: true })
    expect(fs.existsSync(nested)).toBe(true)
  })

  it('resolves not-ok with a reason when the target cannot be written (existing file blocks mkdir)', async () => {
    const blocked = path.join(root, 'blocked-file')
    fs.writeFileSync(blocked, 'not a directory')
    const result = await probeWritable(blocked)
    expect(result.ok).toBe(false)
  })
})
