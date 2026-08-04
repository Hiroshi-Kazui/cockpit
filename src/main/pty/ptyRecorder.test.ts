import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createPtyRecorder,
  createPtyRecorderFromEnv,
  formatRecordLine,
  recordFileName
} from './ptyRecorder'

describe('formatRecordLine / recordFileName', () => {
  it('writes one JSON object per line, escaping control bytes so a log stays parseable', () => {
    const line = formatRecordLine({ t: 12, k: 'out', d: '\u001b[2Jあ\r\n' })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.split('\n')).toHaveLength(2)
    expect(JSON.parse(line)).toEqual({ t: 12, k: 'out', d: '\u001b[2Jあ\r\n' })
  })

  it('names one file per spawn so a restarted pane never shares a log', () => {
    expect(recordFileName(2, 1700000000000)).toBe('pane2-1700000000000.jsonl')
    expect(recordFileName(2, 1700000000001)).not.toBe(recordFileName(2, 1700000000000))
  })
})

describe('createPtyRecorder', () => {
  it('is disabled (null, and touches no filesystem) without a directory', () => {
    expect(createPtyRecorder(null)).toBeNull()
    expect(createPtyRecorder(undefined)).toBeNull()
    expect(createPtyRecorder('')).toBeNull()
  })

  it('is disabled unless COCKPIT_PTY_LOG_DIR is set', () => {
    expect(createPtyRecorderFromEnv({})).toBeNull()
    expect(createPtyRecorderFromEnv({ COCKPIT_PTY_LOG_DIR: '' })).toBeNull()
  })

  it('records spawn/out/resize/exit for one pane in order, with relative timestamps', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-ptyrec-'))
    try {
      let clock = 1000
      const recorder = createPtyRecorder(dir, () => clock)
      expect(recorder).not.toBeNull()

      recorder?.spawned(1, 'C:\\repo', 80, 30)
      clock = 1050
      recorder?.data(1, 'hello\r\n')
      clock = 1100
      recorder?.resized(1, 120, 40)
      clock = 1200
      recorder?.exited(1, 0)

      const file = path.join(dir, recordFileName(1, 1000))
      const events = fs
        .readFileSync(file, 'utf-8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(events).toEqual([
        { t: 0, k: 'spawn', cols: 80, rows: 30, cwd: 'C:\\repo' },
        { t: 50, k: 'out', d: 'hello\r\n' },
        { t: 100, k: 'resize', cols: 120, rows: 40 },
        { t: 200, k: 'exit', code: 0 }
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores events for a pane that has not spawned (and after it exited)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-ptyrec-'))
    try {
      const recorder = createPtyRecorder(dir, () => 5000)
      recorder?.data(0, 'orphan output')
      recorder?.resized(0, 80, 24)
      expect(fs.readdirSync(dir)).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
