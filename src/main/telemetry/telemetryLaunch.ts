// Orchestrates one pane launch's telemetry setup (spec §4.3, TD-4): writes a fresh forwarder settings
// file, snapshots the user's own statusLine command for chaining, and builds the env vars the pty
// process needs so resources/statusline-forwarder.js can find the pipe and identify its pane.
import path from 'node:path'
import { app } from 'electron'
import type { PaneIndex } from '../../shared/ipc'
import { resolveForwarderScriptPath } from './forwarderPath'
import { snapshotUserStatusLineCommand, writeForwarderSettings } from './settingsWriter'

export interface TelemetryLaunchConfig {
  settingsPath: string
  extraEnv: Record<string, string>
}

/** Env var names the forwarder script (resources/statusline-forwarder.js) reads. Kept as named
 * constants so ptyManager/telemetryLaunch/the forwarder script agree on the contract in one place. */
export const TELEMETRY_ENV = {
  pane: 'COCKPIT_PANE',
  pipeName: 'COCKPIT_PIPE_NAME',
  chainedCommand: 'COCKPIT_CHAINED_STATUSLINE_COMMAND'
} as const

/**
 * Builds a per-pane telemetry launch preparer bound to one pipeName (one per app instance). Called once
 * per `PtyManager.spawn()` (i.e. per fresh "claude 起動" click), so the statusLine chain snapshot is
 * taken fresh at session-start time per TD-4 ("動的 merge はしない").
 */
export function createTelemetryLaunchPreparer(
  pipeName: string
): (pane: PaneIndex) => TelemetryLaunchConfig {
  const forwarderScriptPath = resolveForwarderScriptPath()
  const settingsDir = path.join(app.getPath('userData'), 'settings')

  return (pane: PaneIndex): TelemetryLaunchConfig => {
    const { settingsPath } = writeForwarderSettings(settingsDir, pane, forwarderScriptPath)
    const chain = snapshotUserStatusLineCommand()
    const extraEnv: Record<string, string> = {
      [TELEMETRY_ENV.pane]: String(pane),
      [TELEMETRY_ENV.pipeName]: pipeName
    }
    if (chain.command) extraEnv[TELEMETRY_ENV.chainedCommand] = chain.command
    return { settingsPath, extraEnv }
  }
}
