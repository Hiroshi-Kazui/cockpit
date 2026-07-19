// Unit tests for createArchiveBrowser's composition/error-mapping logic (M5, spec §4.4), against plain
// fakes rather than a real SQLite/filesystem -- see archiveBrowser.ts's file header for why.
import { describe, expect, it, vi } from 'vitest'
import {
  createArchiveBrowser,
  type ArchiveBrowserDeps,
  type SessionJsonlLookup
} from './archiveBrowser'
import { ArchiveTranscriptReadError, type ReadArchivedTranscriptResult } from './archiveReader'
import type { SessionListRow } from '../db/sessionRepo'

function makeDeps(overrides: Partial<ArchiveBrowserDeps> = {}): ArchiveBrowserDeps {
  return {
    listSessions: vi.fn(() => []),
    getSessionJsonlPath: vi.fn((): SessionJsonlLookup => ({ found: false })),
    readTranscript: vi.fn(() => Promise.resolve({ turns: [], truncated: false, omittedCount: 0 })),
    ...overrides
  }
}

describe('createArchiveBrowser.listSessions', () => {
  it('maps deps.listSessions rows to renderer DTOs (PaneIndex-narrowed) with the given query', () => {
    const row: SessionListRow = {
      id: 'sess-1',
      pane: 0,
      purpose: 'READMEを直す',
      title: 'README修正',
      cwd: 'C:\\repo',
      startedAt: 1000,
      endedAt: null,
      model: 'claude-sonnet',
      tokensIn: 10,
      tokensOut: 20,
      tokensCacheRead: 0,
      tokensCacheWrite: 0
    }
    const listSessions = vi.fn(() => [row])
    const browser = createArchiveBrowser(makeDeps({ listSessions }))

    const result = browser.listSessions({ searchText: 'README' })

    expect(result).toEqual([row])
    expect(listSessions).toHaveBeenCalledWith({ searchText: 'README' })
  })

  it('throws if a row carries an out-of-range pane value (data-integrity guard, never silently clamped)', () => {
    const row: SessionListRow = {
      id: 'sess-bad',
      pane: 9,
      purpose: null,
      title: null,
      cwd: null,
      startedAt: 1000,
      endedAt: null,
      model: null,
      tokensIn: 0,
      tokensOut: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0
    }
    const browser = createArchiveBrowser(makeDeps({ listSessions: () => [row] }))

    expect(() => browser.listSessions({ searchText: '' })).toThrow(RangeError)
  })
})

describe('createArchiveBrowser.readSession', () => {
  it('returns a typed not-found failure when the session id is unknown', async () => {
    const browser = createArchiveBrowser(
      makeDeps({ getSessionJsonlPath: () => ({ found: false }) })
    )

    const result = await browser.readSession('sess-missing')

    expect(result).toEqual({ ok: false, reason: expect.stringContaining('sess-missing') })
  })

  it('returns a typed failure when the session has no archived jsonlPath yet', async () => {
    const browser = createArchiveBrowser(
      makeDeps({ getSessionJsonlPath: () => ({ found: true, jsonlPath: null }) })
    )

    const result = await browser.readSession('sess-1')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('sess-1')
  })

  it('returns the parsed turns and truncation info on success', async () => {
    const readResult: ReadArchivedTranscriptResult = {
      turns: [{ role: 'user' as const, text: 'hello', timestampMs: 1 }],
      truncated: true,
      omittedCount: 42
    }
    const readTranscript = vi.fn(() => Promise.resolve(readResult))
    const browser = createArchiveBrowser(
      makeDeps({
        getSessionJsonlPath: () => ({
          found: true,
          jsonlPath: 'C:\\archive\\sess-1\\transcript.jsonl'
        }),
        readTranscript
      })
    )

    const result = await browser.readSession('sess-1')

    expect(result).toEqual({ ok: true, turns: readResult.turns, truncated: true, omittedCount: 42 })
    expect(readTranscript).toHaveBeenCalledWith('C:\\archive\\sess-1\\transcript.jsonl')
  })

  it('maps an ArchiveTranscriptReadError to a typed failure with its message', async () => {
    const browser = createArchiveBrowser(
      makeDeps({
        getSessionJsonlPath: () => ({
          found: true,
          jsonlPath: 'C:\\archive\\sess-1\\transcript.jsonl'
        }),
        readTranscript: () => {
          throw new ArchiveTranscriptReadError(
            'refusing to read transcript outside the archive root'
          )
        }
      })
    )

    const result = await browser.readSession('sess-1')

    expect(result).toEqual({
      ok: false,
      reason: 'refusing to read transcript outside the archive root'
    })
  })

  it('maps a non-ArchiveTranscriptReadError failure to a typed failure too (never rejects/throws through)', async () => {
    const browser = createArchiveBrowser(
      makeDeps({
        getSessionJsonlPath: () => ({
          found: true,
          jsonlPath: 'C:\\archive\\sess-1\\transcript.jsonl'
        }),
        readTranscript: () => {
          throw new Error('unexpected')
        }
      })
    )

    await expect(browser.readSession('sess-1')).resolves.toEqual({
      ok: false,
      reason: 'Error: unexpected'
    })
  })
})
