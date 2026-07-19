// Tests for the TD-4 settings-file generator and statusLine-chain snapshotter, against real temp files.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { snapshotUserStatusLineCommand, writeForwarderSettings } from './settingsWriter'

describe('writeForwarderSettings', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-settingswriter-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes a settings.json registering the forwarder as statusLine command for the given pane', () => {
    const { settingsPath } = writeForwarderSettings(tmpDir, 2, 'C:\\app\\resources\\forwarder.js')
    expect(fs.existsSync(settingsPath)).toBe(true)
    expect(path.basename(settingsPath)).toBe('pane-2.settings.json')
    const content = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(content.statusLine.type).toBe('command')
    expect(content.statusLine.command).toContain('forwarder.js')
    expect(content.statusLine.command.startsWith('node ')).toBe(true)
  })

  it('creates the target directory if it does not exist yet', () => {
    const nested = path.join(tmpDir, 'nested', 'settings')
    const { settingsPath } = writeForwarderSettings(nested, 0, 'C:\\forwarder.js')
    expect(fs.existsSync(settingsPath)).toBe(true)
  })

  it('overwrites a previous settings file for the same pane on a fresh launch (TD-4: snapshot per launch)', () => {
    const first = writeForwarderSettings(tmpDir, 1, 'C:\\old\\forwarder.js')
    const second = writeForwarderSettings(tmpDir, 1, 'C:\\new\\forwarder.js')
    expect(second.settingsPath).toBe(first.settingsPath)
    const content = JSON.parse(fs.readFileSync(second.settingsPath, 'utf-8'))
    expect(content.statusLine.command).toContain('new')
    expect(content.statusLine.command).not.toContain('old')
  })
})

describe('snapshotUserStatusLineCommand', () => {
  it('never throws and returns a well-typed result regardless of whether ~/.claude/settings.json exists', () => {
    const result = snapshotUserStatusLineCommand()
    expect(result).toHaveProperty('command')
    expect(result.command === null || typeof result.command === 'string').toBe(true)
  })
})
