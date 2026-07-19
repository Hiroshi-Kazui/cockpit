// Generates the per-pane, per-launch claude `--settings` file that registers the statusline forwarder
// (spec §4.3, TD-4), and snapshots the user's own existing statusLine command for chaining. Both
// functions are side-effecting FS operations but kept dependency-free (only node:fs/os/path) so they
// can be exercised in unit tests without Electron.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface UserStatusLineSnapshot {
  command: string | null
}

/**
 * Side-effecting: read ~/.claude/settings.json and extract the user's own statusLine command, if any.
 * Tolerant of a missing/unreadable/malformed file or an unexpected shape (spec §7) -- never throws.
 */
export function snapshotUserStatusLineCommand(): UserStatusLineSnapshot {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { command: null }
    const statusLine = (parsed as Record<string, unknown>)['statusLine']
    if (typeof statusLine !== 'object' || statusLine === null) return { command: null }
    const command = (statusLine as Record<string, unknown>)['command']
    return { command: typeof command === 'string' && command.length > 0 ? command : null }
  } catch {
    return { command: null }
  }
}

export interface GeneratedSettings {
  settingsPath: string
}

/**
 * Side-effecting: write a fresh app-generated settings JSON for one pane launch, registering the
 * forwarder script as the statusLine command (TD-4). Overwrites any previous file for this pane on
 * every call -- this is our own generated artifact (never the user's ~/.claude/settings.json), so
 * overwriting it does not touch the append-only archive invariant, which applies only to the session
 * transcript (spec §4.4).
 */
export function writeForwarderSettings(
  targetDir: string,
  pane: number,
  forwarderScriptPath: string
): GeneratedSettings {
  fs.mkdirSync(targetDir, { recursive: true })
  const settingsPath = path.join(targetDir, `pane-${pane}.settings.json`)
  const content = {
    statusLine: {
      type: 'command',
      command: `node ${JSON.stringify(forwarderScriptPath)}`
    }
  }
  fs.writeFileSync(settingsPath, JSON.stringify(content, null, 2), 'utf-8')
  return { settingsPath }
}
