// Pure path-containment helper (M2 FIX iteration 2, security). Used as defense-in-depth wherever an
// on-disk path is built by joining a trusted root directory with an untrusted segment (e.g. a
// telemetry-pipe-sourced session_id, see shared/statusline.ts's isValidSessionId for the primary
// whitelist check on that value). Even if the untrusted segment somehow slipped past whitelist
// validation, this still refuses to hand back a path that resolves outside the root.
import path from 'node:path'

/**
 * Joins `root` with `segment` and verifies the resolved path stays within `root`. Returns the resolved
 * absolute path if contained, or `null` if `segment` would cause the result to escape `root` (path
 * traversal, e.g. via `..` or an absolute/drive-qualified segment on Windows).
 */
export function resolveContainedPath(root: string, segment: string): string | null {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, segment)
  const relative = path.relative(resolvedRoot, resolved)
  if (relative === '') return resolvedRoot
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return resolved
}
