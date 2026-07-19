// Resolves the on-disk path to the statusline forwarder resource script (TD-4).
import path from 'node:path'
import { app } from 'electron'

/**
 * Packaged builds must ship resources/ via electron-builder's `extraResources` (not yet configured --
 * no electron-builder config exists in this repo as of M2, since packaging/distribution is out of scope
 * for M2's acceptance criteria). Dev-mode resolution via app.getAppPath() is what M2 requires and is
 * what `npm run dev` (electron-vite dev) exercises.
 */
export function resolveForwarderScriptPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'statusline-forwarder.js')
  }
  return path.join(app.getAppPath(), 'resources', 'statusline-forwarder.js')
}
