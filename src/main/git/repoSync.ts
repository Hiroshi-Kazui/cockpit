// Orchestrates the M11 git working-tree sync attempted before a "＋ 新規セッション" launch (spec §4.2
// addendum, ADR-0013). Resolves the target's repo root, serializes/observes concurrent same-repo launches
// (repoSyncLock.ts, FIX M2), reads the worktree status and branch/remote facts, hands them to
// shared/gitSync.ts's pure planRepoSync exactly once with the real gathered facts (FIX B1), and executes at
// most one checkout + one pull. gitCli, the alert dialog, the running-pane lookup, and the lock are all
// injected ports (dependency inversion, mirroring purposeCoordinator.ts's style) so this whole module is
// unit-testable without Electron/child_process, and so it never imports PtyManager/paneSettingsRepo/
// Electron directly (R-6/R-7).
import path from 'node:path'
import {
  areSameRepoRoot,
  describeRepoSyncOutcome,
  extractBranchFromRemoteHeadRef,
  parsePorcelainStatus,
  planRepoSync,
  resolveDefaultBranch
} from '../../shared/gitSync'
import type { PaneIndex, RepoSyncOutcome } from '../../shared/ipc'
import { GIT_TIMEOUT_MS, type GitCliResult } from './gitCli'
import type { RepoSyncLock } from './repoSyncLock'

/** R-3 "先頭数件": how many changed-file paths are quoted in the commit-prompt alert/notification. */
const DIRTY_SAMPLE_PATH_LIMIT = 5

export interface RunningPaneCwd {
  pane: PaneIndex
  cwd: string
}

export interface RepoSyncDeps {
  git: (args: readonly string[], cwd: string, timeoutMs: number) => Promise<GitCliResult>
  /** Every pane (other than the one about to launch) that currently has claude running, with the cwd it
   * was actually spawned with (FIX M3, review iter1: `PtyManager.getRunningCwd`, not a re-lookup of
   * pane_settings.default_cwd, which can drift after spawn). This port only answers "what's running, and
   * where" -- repoSync.ts itself resolves each candidate's own repo root (via `git`) and compares it
   * against the launch target's (areSameRepoRoot, R-6), so a candidate whose cwd is merely a
   * *subdirectory* of the same repo is still correctly recognized as "same repo". */
  listRunningPanes: () => readonly RunningPaneCwd[]
  /** Shows the native "commit を促す" / "他ペイン使用中" alert (D-9). Never imports Electron directly. */
  showAlert: (message: string) => Promise<void>
  /** FIX M2 (review iter1): serializes concurrent launches targeting the same repo root, and lets a
   * launch that arrives while another is still mid-flight (before either pty has even spawned, so
   * `listRunningPanes` alone could never see it) observe that and block instead of racing on
   * `git checkout`/`git pull`. */
  repoLock: RepoSyncLock
}

function isNotARepoError(result: GitCliResult): boolean {
  return (
    result.ok === false && result.kind === 'error' && /not a git repository/i.test(result.message)
  )
}

/** `git rev-parse --show-toplevel` always prints forward-slash-separated output, even on Windows;
 * path.resolve normalizes it to the platform's native separator and collapses any redundant segments. */
function normalizeGitToplevel(stdout: string): string {
  return path.resolve(stdout.trim())
}

function splitNonEmptyLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** FIX M4 (review iter1): whether `branch` has an upstream configured in `repoRoot`. A repo with a remote
 * but no upstream for the current branch makes `git pull --ff-only` fail every single time with "There is
 * no tracking information for the current branch" -- that is not an actionable *failure* the way a
 * non-fast-forward or auth error is, so it is treated as a `skipped` outcome instead of `failed` (FIX M4). */
async function hasUpstream(repoRoot: string, branch: string, deps: RepoSyncDeps): Promise<boolean> {
  const result = await deps.git(
    ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
    repoRoot,
    GIT_TIMEOUT_MS.query
  )
  return result.ok
}

/**
 * Runs the full M11 sync for a "＋ 新規セッション" launch targeting `cwd` in pane `pane`. Never throws and
 * never lets an unexpected exception here block the caller's spawn (ADR-0013/D-2/R-9) -- any bug in this
 * module degrades to a visible `{ kind: 'failed' }` outcome rather than an unhandled rejection.
 */
export async function prepareRepoForLaunch(
  pane: PaneIndex,
  cwd: string,
  deps: RepoSyncDeps
): Promise<RepoSyncOutcome> {
  try {
    return await runSync(pane, cwd, deps)
  } catch (err) {
    console.error('[gitSync] unexpected exception during repo sync, continuing launch anyway', err)
    return {
      kind: 'failed',
      repoRoot: cwd,
      step: 'status',
      message: err instanceof Error ? err.message : String(err)
    }
  }
}

async function runSync(pane: PaneIndex, cwd: string, deps: RepoSyncDeps): Promise<RepoSyncOutcome> {
  // ---- R-2: repository detection ----
  const topLevel = await deps.git(['rev-parse', '--show-toplevel'], cwd, GIT_TIMEOUT_MS.query)
  if (!topLevel.ok) {
    if (topLevel.kind === 'enoent') return { kind: 'git-unavailable', message: topLevel.message }
    if (isNotARepoError(topLevel)) return { kind: 'not-a-repo' }
    // Neither "no git" nor "not a repo" (permission/corrupt-repo/timeout) -- still must not block launch.
    return { kind: 'failed', repoRoot: cwd, step: 'status', message: topLevel.message }
  }
  // FIX minor-C (review iter1): an empty/whitespace-only stdout would otherwise resolve via
  // `path.resolve('')` to *this process's own cwd* -- a silent misattribution, not a real repo root.
  if (topLevel.stdout.trim().length === 0) {
    return {
      kind: 'failed',
      repoRoot: cwd,
      step: 'status',
      message: 'git rev-parse --show-toplevel returned empty output'
    }
  }
  const repoRoot = normalizeGitToplevel(topLevel.stdout)

  // FIX M2 (review iter1): claim (or observe already-claimed) the in-flight lock synchronously, with no
  // `await` between the check and the claim, so two nearly-simultaneous launches targeting the same repo
  // can never both proceed past this point (see repoSyncLock.ts's doc comment for why this is race-free).
  const existingHolder = deps.repoLock.holderPane(repoRoot)
  if (existingHolder !== null) {
    // FIX M2 (review iter2): cause:'launching' (not 'running') -- the other pane's own claude hasn't even
    // started yet at this point (its git sync is still in flight), so "claude が実行中" would be false.
    // requiresSwitch is conservatively true here: the other launch's own branch/remote facts aren't
    // available yet to judge this cheaply, and a modal is the safe default.
    const outcome: RepoSyncOutcome = {
      kind: 'blocked-busy',
      repoRoot,
      busyPanes: [existingHolder],
      cause: 'launching',
      requiresSwitch: true
    }
    await deps.showAlert(describeRepoSyncOutcome(outcome))
    return outcome
  }
  return deps.repoLock.withLock(repoRoot, pane, () => runLockedSync(repoRoot, deps))
}

async function runLockedSync(repoRoot: string, deps: RepoSyncDeps): Promise<RepoSyncOutcome> {
  // ---- FIX B1 (review iter1): gather every fact concurrently, then call planRepoSync exactly once with
  // the real values -- no separate inline dirty/busy pre-checks, so the pure function's own precedence
  // (dirty blocks unconditionally; busy only blocks when a switch is actually needed, FIX M6) is what
  // actually runs, not a duplicate (and previously inverted-priority) copy of it here. ----
  const [statusResult, busyPanes, branchResult, remotesResult, localBranchesResult] =
    await Promise.all([
      deps.git(
        ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
        repoRoot,
        GIT_TIMEOUT_MS.query
      ),
      resolveLiveBusyPanes(repoRoot, deps),
      deps.git(['branch', '--show-current'], repoRoot, GIT_TIMEOUT_MS.query),
      deps.git(['remote'], repoRoot, GIT_TIMEOUT_MS.query),
      deps.git(
        ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
        repoRoot,
        GIT_TIMEOUT_MS.query
      )
    ])

  if (!statusResult.ok) {
    return { kind: 'failed', repoRoot, step: 'status', message: statusResult.message }
  }
  // FIX B2 (review iter1): a failed branch/remote/local-branches query must never be silently mapped to
  // "null"/"[]" and fed to planRepoSync as if it meant "no branch"/"no remote" -- that previously let a
  // `git remote` query failure produce an inaccurate "remote が未設定のため pull はスキップしました"
  // message while still moving the branch. Report the failure and stop before ever touching the worktree.
  if (!branchResult.ok || !remotesResult.ok || !localBranchesResult.ok) {
    const failed = [branchResult, remotesResult, localBranchesResult].find((r) => !r.ok)
    const message = failed && !failed.ok ? failed.message : 'unknown git query failure'
    return { kind: 'failed', repoRoot, step: 'status', message }
  }

  const status = parsePorcelainStatus(statusResult.stdout)
  const currentBranch = branchResult.stdout.trim().length > 0 ? branchResult.stdout.trim() : null
  const remotes = splitNonEmptyLines(remotesResult.stdout)
  const localBranches = splitNonEmptyLines(localBranchesResult.stdout)

  const remoteHeads: Record<string, string | null> = {}
  await Promise.all(
    remotes.map(async (remote) => {
      const result = await deps.git(
        ['symbolic-ref', `refs/remotes/${remote}/HEAD`],
        repoRoot,
        GIT_TIMEOUT_MS.query
      )
      remoteHeads[remote] = result.ok
        ? extractBranchFromRemoteHeadRef(result.stdout.trim(), remote)
        : null
    })
  )
  const defaultBranch = resolveDefaultBranch({ remoteHeads, remotes, localBranches })

  const plan = planRepoSync({
    hasTrackedChanges: status.hasTrackedChanges,
    hasUntracked: status.hasUntracked,
    busyPanes,
    currentBranch,
    defaultBranch,
    hasRemote: remotes.length > 0
  })

  switch (plan.action) {
    case 'block-dirty': {
      const outcome: RepoSyncOutcome = {
        kind: 'blocked-dirty',
        repoRoot,
        changedCount: status.entries.length,
        samplePaths: status.entries.slice(0, DIRTY_SAMPLE_PATH_LIMIT).map((e) => e.path),
        currentBranch
      }
      await deps.showAlert(describeRepoSyncOutcome(outcome))
      return outcome
    }

    case 'block-busy': {
      // FIX B2/M6 (review iter2): busy blocks unconditionally (reverted from iter1's relaxation), but a
      // modal only interrupts the user when a `checkout` would actually have run -- an in-place `pull`
      // that never runs (plan.requiresSwitch === false) is reported via the notification row only.
      const outcome: RepoSyncOutcome = {
        kind: 'blocked-busy',
        repoRoot,
        busyPanes,
        cause: 'running',
        requiresSwitch: plan.requiresSwitch
      }
      if (plan.requiresSwitch) {
        await deps.showAlert(describeRepoSyncOutcome(outcome))
      }
      return outcome
    }

    case 'skip':
      return { kind: 'skipped', reason: plan.reason }

    case 'pull-only': {
      // FIX M1 (review iter2): a missing upstream is reported as `synced` (branch is known, pull just
      // didn't run) rather than `skipped` -- `skipped` is reserved for "nothing about the branch state is
      // known/changed" (see the `skip` plan action above), never for "we know the branch, pull just
      // didn't happen".
      if (!(await hasUpstream(repoRoot, plan.targetBranch, deps))) {
        return {
          kind: 'synced',
          repoRoot,
          branch: plan.targetBranch,
          switched: false,
          pulled: false,
          pullSkippedReason: `${plan.targetBranch} に upstream が設定されていないため`
        }
      }
      const pullResult = await deps.git(['pull', '--ff-only'], repoRoot, GIT_TIMEOUT_MS.pull)
      if (!pullResult.ok)
        return { kind: 'failed', repoRoot, step: 'pull', message: pullResult.message }
      return {
        kind: 'synced',
        repoRoot,
        branch: plan.targetBranch,
        switched: false,
        pulled: true,
        pullSkippedReason: null
      }
    }

    case 'switch-only': {
      const checkoutResult = await deps.git(
        ['checkout', plan.targetBranch],
        repoRoot,
        GIT_TIMEOUT_MS.checkout
      )
      if (!checkoutResult.ok) {
        return { kind: 'failed', repoRoot, step: 'checkout', message: checkoutResult.message }
      }
      return {
        kind: 'synced',
        repoRoot,
        branch: plan.targetBranch,
        switched: true,
        fromBranch: currentBranch,
        pulled: false,
        pullSkippedReason: 'remote が未設定のため'
      }
    }

    case 'checkout-and-pull': {
      const checkoutResult = await deps.git(
        ['checkout', plan.targetBranch],
        repoRoot,
        GIT_TIMEOUT_MS.checkout
      )
      if (!checkoutResult.ok) {
        return { kind: 'failed', repoRoot, step: 'checkout', message: checkoutResult.message }
      }
      // FIX M1 (review iter2): the checkout already happened -- reporting this as `skipped` (iter1's
      // behavior) would misrepresent the branch move that did happen as if nothing had. `synced` with
      // `switched: true, pulled: false` states both facts accurately.
      if (!(await hasUpstream(repoRoot, plan.targetBranch, deps))) {
        return {
          kind: 'synced',
          repoRoot,
          branch: plan.targetBranch,
          switched: true,
          fromBranch: currentBranch,
          pulled: false,
          pullSkippedReason: `${plan.targetBranch} に upstream が設定されていないため`
        }
      }
      const pullResult = await deps.git(['pull', '--ff-only'], repoRoot, GIT_TIMEOUT_MS.pull)
      if (!pullResult.ok)
        return { kind: 'failed', repoRoot, step: 'pull', message: pullResult.message }
      return {
        kind: 'synced',
        repoRoot,
        branch: plan.targetBranch,
        switched: true,
        fromBranch: currentBranch,
        pulled: true,
        pullSkippedReason: null
      }
    }
  }
}

/** R-6/D-7: which of `deps.listRunningPanes()` resolve to the same repo root as `repoRoot`. Each
 * candidate's own repo root is resolved via `git` (not compared as a raw cwd string), so a candidate whose
 * cwd is a subdirectory of the same repo is still correctly recognized as "same repo". */
async function resolveLiveBusyPanes(repoRoot: string, deps: RepoSyncDeps): Promise<PaneIndex[]> {
  const runningElsewhere = deps.listRunningPanes()
  const resolved = await Promise.all(
    runningElsewhere.map(async (candidate): Promise<PaneIndex | null> => {
      const candidateTop = await deps.git(
        ['rev-parse', '--show-toplevel'],
        candidate.cwd,
        GIT_TIMEOUT_MS.query
      )
      if (!candidateTop.ok) {
        // FIX M3 (review iter2): only a *confirmed* "not a git repository" result means this candidate is
        // genuinely not-busy. A timeout/ENOENT/permission/other error tells us nothing about whether it's
        // the same repo -- silently treating an inconclusive query as "different repo" (iter1's behavior)
        // could let a checkout/pull proceed alongside a genuinely-live neighbor pane. Erring toward "busy"
        // (the safe side, D-7's whole point) instead.
        if (isNotARepoError(candidateTop)) return null
        console.error(
          `[gitSync] could not resolve repo root for busy-pane candidate (pane ${candidate.pane}, ` +
            `cwd=${candidate.cwd}); treating as busy (safe side)`,
          candidateTop
        )
        return candidate.pane
      }
      // FIX M4 (review iter2): same empty-stdout guard as the launch target's own toplevel resolution in
      // runSync above -- an empty/whitespace-only stdout would otherwise resolve via `path.resolve('')` to
      // *this Electron process's own cwd*, which could spuriously match `repoRoot` if cockpit itself was
      // launched from inside the target repository (e.g. running `npm run dev` from this very project's
      // root during development).
      if (candidateTop.stdout.trim().length === 0) {
        console.error(
          `[gitSync] empty rev-parse output for busy-pane candidate (pane ${candidate.pane}, ` +
            `cwd=${candidate.cwd}); treating as busy (safe side)`
        )
        return candidate.pane
      }
      return areSameRepoRoot(repoRoot, normalizeGitToplevel(candidateTop.stdout))
        ? candidate.pane
        : null
    })
  )
  return resolved.filter((pane): pane is PaneIndex => pane !== null)
}
