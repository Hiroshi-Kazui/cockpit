// Exercises createSpoolReader against a real scratch directory standing in for the spool root -- plain
// node:fs, no Electron/better-sqlite3 (same rationale as fsSink.test.ts).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSpoolReader } from './spoolReader'

describe('createSpoolReader (M6)', () => {
  let spoolRoot: string

  beforeEach(() => {
    spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-spoolreader-test-'))
  })

  afterEach(() => {
    fs.rmSync(spoolRoot, { recursive: true, force: true })
  })

  it('statSpoolTranscript returns null for a session with no archived transcript yet', async () => {
    const reader = createSpoolReader(spoolRoot)
    await expect(reader.statSpoolTranscript('unknown-session')).resolves.toBeNull()
  })

  it('statSpoolTranscript reflects the real file size once one exists', async () => {
    fs.mkdirSync(path.join(spoolRoot, 'sess-1'))
    fs.writeFileSync(path.join(spoolRoot, 'sess-1', 'transcript.jsonl'), '{"a":1}\n')
    const reader = createSpoolReader(spoolRoot)
    await expect(reader.statSpoolTranscript('sess-1')).resolves.toBe(8)
  })

  it('readSpoolBytes reads exactly the requested offset/length window', async () => {
    fs.mkdirSync(path.join(spoolRoot, 'sess-1'))
    fs.writeFileSync(path.join(spoolRoot, 'sess-1', 'transcript.jsonl'), 'abcdefghij')
    const reader = createSpoolReader(spoolRoot)
    const buf = await reader.readSpoolBytes('sess-1', 3, 4)
    expect(buf.toString('utf-8')).toBe('defg')
  })

  it('readSpoolBytes with length 0 returns an empty buffer without opening the file', async () => {
    const reader = createSpoolReader(spoolRoot)
    const buf = await reader.readSpoolBytes('nonexistent-session', 0, 0)
    expect(buf.length).toBe(0)
  })

  it('readSpoolMetadata returns null when metadata.json does not exist yet', async () => {
    const reader = createSpoolReader(spoolRoot)
    await expect(reader.readSpoolMetadata('sess-1')).resolves.toBeNull()
  })

  it('readSpoolMetadata returns the file content when it exists', async () => {
    fs.mkdirSync(path.join(spoolRoot, 'sess-1'))
    fs.writeFileSync(path.join(spoolRoot, 'sess-1', 'metadata.json'), '{"title":"t"}')
    const reader = createSpoolReader(spoolRoot)
    await expect(reader.readSpoolMetadata('sess-1')).resolves.toBe('{"title":"t"}')
  })

  it('listSpoolSessionIds enumerates every session subdirectory', async () => {
    fs.mkdirSync(path.join(spoolRoot, 'sess-1'))
    fs.mkdirSync(path.join(spoolRoot, 'sess-2'))
    fs.writeFileSync(path.join(spoolRoot, 'not-a-dir.txt'), 'x')
    const reader = createSpoolReader(spoolRoot)
    expect(reader.listSpoolSessionIds().sort()).toEqual(['sess-1', 'sess-2'])
  })

  it('listSpoolSessionIds returns an empty array when the spool root does not exist yet', () => {
    const reader = createSpoolReader(path.join(spoolRoot, 'does-not-exist'))
    expect(reader.listSpoolSessionIds()).toEqual([])
  })
})
