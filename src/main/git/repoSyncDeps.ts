// Wires main/git/repoSync.ts's injected ports to their real Electron/PtyManager implementations (M11).
// Extracted out of main/index.ts's createWindow (FIX minor-C, review iter1) so that function stays
// readable -- this is pure wiring, no decision logic of its own.
import { dialog, type BrowserWindow } from 'electron'
import { PANE_INDICES, type PaneIndex } from '../../shared/ipc'
import { runGit } from './gitCli'
import { prepareRepoForLaunch, type RepoSyncDeps, type RunningPaneCwd } from './repoSync'
import { RepoSyncLock } from './repoSyncLock'
import type { PtyManager } from '../pty/ptyManager'

/**
 * Builds the `prepareRepo` function `PurposeCoordinator.startNewSession` calls. `repoLock` (FIX M2) is
 * created once here and closed over for the whole app process's lifetime, shared across every pane's
 * launch -- constructing a fresh one per call would defeat its purpose (serializing *concurrent* launches).
 */
export function createPrepareRepo(
  ptyManager: PtyManager,
  window: BrowserWindow
): (pane: PaneIndex, cwd: string) => ReturnType<typeof prepareRepoForLaunch> {
  const repoLock = new RepoSyncLock()

  const deps: RepoSyncDeps = {
    git: (args, cwd, timeoutMs) => runGit(args, cwd, timeoutMs),
    // FIX M3 (review iter1): the cwd a pane's pty was *actually spawned with* (PtyManager.getRunningCwd),
    // not a re-lookup of pane_settings.default_cwd -- which can drift after spawn, TD-7's own warning about
    // exactly this. A pane with no running pty (including the one currently launching, which by
    // construction never has one yet at this point) is simply absent from the result.
    listRunningPanes: (): RunningPaneCwd[] => {
      const result: RunningPaneCwd[] = []
      for (const pane of PANE_INDICES) {
        const cwd = ptyManager.getRunningCwd(pane)
        if (cwd !== null) result.push({ pane, cwd })
      }
      return result
    },
    showAlert: async (message) => {
      if (window.isDestroyed()) return
      await dialog.showMessageBox(window, {
        type: 'warning',
        buttons: ['OK'],
        message: '新規セッション: git 同期',
        detail: message
      })
    },
    repoLock
  }

  return (pane, cwd) => prepareRepoForLaunch(pane, cwd, deps)
}
