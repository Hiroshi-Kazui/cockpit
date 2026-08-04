// FIX M2 (review iter1, M11): serializes/observes concurrent M11 git-sync attempts targeting the same
// repository root. Without this, two panes both configured to the same repo, both idle, whose "＋ 新規
// セッション" is clicked within the same tick, would BOTH pass the ordinary PtyManager.isRunning-based busy
// check (repoSync.ts's listRunningPanes) -- neither pty has actually spawned yet at the moment either
// launch's busy check runs, since spawning only happens *after* the git sync itself completes. Both would
// then race on `git checkout`/`git pull` in the same working tree, typically failing on a stale
// `.git/index.lock`. One process-lifetime instance is shared across every pane's launch (wired via
// repoSyncDeps.ts); tests construct their own so lock state never leaks between cases.
import type { PaneIndex } from '../../shared/ipc'
import { normalizeRepoRootForComparison } from '../../shared/gitSync'

export class RepoSyncLock {
  private readonly holders = new Map<string, PaneIndex>()

  /**
   * Returns the pane currently holding the lock for `repoRoot`, or null if unheld. Callers must check this
   * *and* call `withLock` in the same synchronous turn (no `await` in between) for the atomicity guarantee
   * to hold -- see `withLock`'s doc comment.
   */
  holderPane(repoRoot: string): PaneIndex | null {
    return this.holders.get(normalizeRepoRootForComparison(repoRoot)) ?? null
  }

  /**
   * Claims the lock for `repoRoot` under `pane`, runs `fn`, and always releases it afterward (success or
   * throw). The claim (`this.holders.set(...)` below) happens synchronously, before `fn` is ever invoked or
   * awaited -- so a caller that does `if (lock.holderPane(root) === null) return lock.withLock(root, pane,
   * fn)` with no `await` between the check and this call is race-free: Node's single-threaded event loop
   * guarantees no other code can run between those two synchronous statements, so whichever of two
   * simultaneously-arriving launches' promise-resolution callbacks happens to run first will always win the
   * claim before the other one's callback body even starts executing.
   */
  async withLock<T>(repoRoot: string, pane: PaneIndex, fn: () => Promise<T>): Promise<T> {
    const key = normalizeRepoRootForComparison(repoRoot)
    this.holders.set(key, pane)
    try {
      return await fn()
    } finally {
      this.holders.delete(key)
    }
  }
}
