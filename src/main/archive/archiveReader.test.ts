// Behavioral tests for readArchivedTranscript against real temp files (mirrors archiver.test.ts's tmpdir
// pattern): verifies the M5 read-only session viewer's parsing + path-containment defense-in-depth
// (spec §4.4), the M5 FIX (deferred item 2) turn-count cap/truncation reporting, and the M5 FIX (deferred
// item 1) symlink-aware containment recheck.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ArchiveTranscriptReadError,
  MAX_DISPLAY_TURNS,
  readArchivedTranscript,
  type ArchiveReaderDeps
} from './archiveReader'

describe('readArchivedTranscript', () => {
  let tmpDir: string
  let archiveRoot: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-archive-reader-test-'))
    archiveRoot = path.join(tmpDir, 'archive')
    fs.mkdirSync(archiveRoot, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reads and parses every display turn from an archived transcript, in order', async () => {
    const sessionDir = path.join(archiveRoot, 'sess-1')
    fs.mkdirSync(sessionDir, { recursive: true })
    const jsonlPath = path.join(sessionDir, 'transcript.jsonl')
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'READMEを直して' },
        timestamp: '2026-07-19T12:00:00.000Z'
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: '了解しました' },
        timestamp: '2026-07-19T12:00:05.000Z'
      })
    ]
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n')

    const result = await readArchivedTranscript(archiveRoot, jsonlPath)

    expect(result).toEqual({
      turns: [
        {
          role: 'user',
          text: 'READMEを直して',
          timestampMs: Date.parse('2026-07-19T12:00:00.000Z')
        },
        {
          role: 'assistant',
          text: '了解しました',
          timestampMs: Date.parse('2026-07-19T12:00:05.000Z')
        }
      ],
      truncated: false,
      omittedCount: 0
    })
  })

  it('skips lines that carry no renderable display turn (tool_result-only, blank, malformed)', async () => {
    const sessionDir = path.join(archiveRoot, 'sess-2')
    fs.mkdirSync(sessionDir, { recursive: true })
    const jsonlPath = path.join(sessionDir, 'transcript.jsonl')
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      '',
      '{"type": "user", "message": ', // malformed
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }
      }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi there' } })
    ]
    fs.writeFileSync(jsonlPath, lines.join('\n'))

    const result = await readArchivedTranscript(archiveRoot, jsonlPath)

    expect(result).toEqual({
      turns: [
        { role: 'user', text: 'hello', timestampMs: null },
        { role: 'assistant', text: 'hi there', timestampMs: null }
      ],
      truncated: false,
      omittedCount: 0
    })
  })

  it('throws ArchiveTranscriptReadError (not a raw fs error) when the file does not exist', async () => {
    const jsonlPath = path.join(archiveRoot, 'sess-missing', 'transcript.jsonl')
    await expect(readArchivedTranscript(archiveRoot, jsonlPath)).rejects.toThrow(
      ArchiveTranscriptReadError
    )
  })

  it('refuses to read a jsonlPath that resolves outside the archive root (defense-in-depth)', async () => {
    const outsideDir = path.join(tmpDir, 'outside')
    fs.mkdirSync(outsideDir, { recursive: true })
    const outsidePath = path.join(outsideDir, 'secret.jsonl')
    fs.writeFileSync(
      outsidePath,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } })
    )

    await expect(readArchivedTranscript(archiveRoot, outsidePath)).rejects.toThrow(
      ArchiveTranscriptReadError
    )
    await expect(readArchivedTranscript(archiveRoot, outsidePath)).rejects.toThrow(
      /outside the archive root/
    )
  })

  it('refuses a traversal segment even if constructed relative to the root', async () => {
    await expect(
      readArchivedTranscript(archiveRoot, path.join(archiveRoot, '..', 'evil', 'transcript.jsonl'))
    ).rejects.toThrow(ArchiveTranscriptReadError)
  })

  it('caps the returned turns at MAX_DISPLAY_TURNS, keeping the newest and reporting how many were omitted', async () => {
    const sessionDir = path.join(archiveRoot, 'sess-huge')
    fs.mkdirSync(sessionDir, { recursive: true })
    const jsonlPath = path.join(sessionDir, 'transcript.jsonl')
    const totalTurns = MAX_DISPLAY_TURNS + 37
    const lines = Array.from({ length: totalTurns }, (_, i) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: `turn-${i}` } })
    )
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n')

    const result = await readArchivedTranscript(archiveRoot, jsonlPath)

    expect(result.truncated).toBe(true)
    expect(result.omittedCount).toBe(37)
    expect(result.turns).toHaveLength(MAX_DISPLAY_TURNS)
    // The newest turns are kept (oldest dropped first) -- turn-0..turn-36 are omitted.
    expect(result.turns[0]).toEqual({ role: 'user', text: 'turn-37', timestampMs: null })
    expect(result.turns[result.turns.length - 1]).toEqual({
      role: 'user',
      text: `turn-${totalTurns - 1}`,
      timestampMs: null
    })
  })

  it('does not report truncation when the turn count is exactly at the cap', async () => {
    const sessionDir = path.join(archiveRoot, 'sess-exact')
    fs.mkdirSync(sessionDir, { recursive: true })
    const jsonlPath = path.join(sessionDir, 'transcript.jsonl')
    const lines = Array.from({ length: MAX_DISPLAY_TURNS }, (_, i) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: `turn-${i}` } })
    )
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n')

    const result = await readArchivedTranscript(archiveRoot, jsonlPath)

    expect(result.truncated).toBe(false)
    expect(result.omittedCount).toBe(0)
    expect(result.turns).toHaveLength(MAX_DISPLAY_TURNS)
  })

  // M5 FIX (deferred item 1): a real symlink-escape test would need to create an actual filesystem
  // symlink pointing outside archiveRoot, which requires elevated privileges/Developer Mode on Windows
  // (not guaranteed available in whatever environment runs this suite) -- so this exercises the exact
  // same containment-recheck code path via the injectable `deps.realpath` seam instead: the string-based
  // path (layer 1) looks contained, but its *real* (symlink-resolved) path is not, exactly as would happen
  // if `sessionDir/transcript.jsonl` under `archiveRoot` were actually a symlink to a file outside it.
  it('refuses a path that is string-contained but resolves outside the archive root via a symlink', async () => {
    const sessionDir = path.join(archiveRoot, 'sess-symlink')
    fs.mkdirSync(sessionDir, { recursive: true })
    const jsonlPath = path.join(sessionDir, 'transcript.jsonl')
    // The file exists on disk (so a naive "does the path exist" check would pass); what makes it a
    // symlink-escape scenario here is purely the fake realpath below resolving it to a location outside
    // archiveRoot, standing in for what `fs.realpath` would return for a real symlink.
    fs.writeFileSync(
      jsonlPath,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } })
    )
    const outsideRealPath = path.join(tmpDir, 'outside', 'secret.jsonl')

    const fakeDeps: ArchiveReaderDeps = {
      realpath: async (p) => (p === jsonlPath ? outsideRealPath : path.resolve(archiveRoot)),
      readFile: async () => {
        throw new Error('should not be reached: containment must be rejected before reading')
      }
    }

    await expect(readArchivedTranscript(archiveRoot, jsonlPath, fakeDeps)).rejects.toThrow(
      ArchiveTranscriptReadError
    )
    await expect(readArchivedTranscript(archiveRoot, jsonlPath, fakeDeps)).rejects.toThrow(
      /outside the archive root/
    )
  })
})
