// Behavioral tests for prepareRepoForLaunch (spec §4.2 addendum, ADR-0013), using fully in-memory fakes
// for gitCli/dialog/running-pane-lookup (mirrors purposeCoordinator.test.ts's style) plus the real
// RepoSyncLock (simple/pure enough that faking it would just re-test the fake) -- no real git process, no
// Electron, no PtyManager/paneSettingsRepo.
import { describe, expect, it, vi } from 'vitest'
import { prepareRepoForLaunch, type RepoSyncDeps, type RunningPaneCwd } from './repoSync'
import { GIT_TIMEOUT_MS, type GitCliResult } from './gitCli'
import { RepoSyncLock } from './repoSyncLock'
import type { RepoSyncOutcome } from '../../shared/ipc'

interface GitCall {
  args: string[]
  cwd: string
  timeoutMs: number
}

/** Builds a fake `git` dep that dispatches on `args[0]` (and, for `rev-parse`, on `args[1]` too, since both
 * the repo-root resolution and the M4 upstream check share the `rev-parse` subcommand) to a caller-supplied
 * per-subcommand result map, recording every call. `revParseTopLevelByCwd` lets a `--show-toplevel` call be
 * keyed by `cwd` so tests can give the launch target and a "busy"/subdirectory candidate's cwd different
 * repo roots. `upstream` defaults to "has an upstream" so tests that don't care about M4 don't need to
 * override it. */
function makeFakeGit(options: {
  revParseTopLevelByCwd?: Record<string, GitCliResult>
  status?: GitCliResult
  branchShowCurrent?: GitCliResult
  remote?: GitCliResult
  forEachRef?: GitCliResult
  symbolicRef?: Record<string, GitCliResult>
  checkout?: GitCliResult
  pull?: GitCliResult
  upstream?: GitCliResult
}): { git: RepoSyncDeps['git']; calls: GitCall[] } {
  const calls: GitCall[] = []
  const git: RepoSyncDeps['git'] = async (args, cwd, timeoutMs) => {
    calls.push({ args: [...args], cwd, timeoutMs })
    const sub = args[0]
    if (sub === 'rev-parse') {
      if (args[1] === '--show-toplevel') {
        return options.revParseTopLevelByCwd?.[cwd] ?? { ok: true, stdout: cwd }
      }
      return options.upstream ?? { ok: true, stdout: 'origin/main\n' }
    }
    if (sub === 'status') return options.status ?? { ok: true, stdout: '' }
    if (sub === 'branch') return options.branchShowCurrent ?? { ok: true, stdout: '' }
    if (sub === 'remote') return options.remote ?? { ok: true, stdout: '' }
    if (sub === 'for-each-ref') return options.forEachRef ?? { ok: true, stdout: '' }
    if (sub === 'symbolic-ref') {
      const ref = args[1]
      return options.symbolicRef?.[ref] ?? { ok: false, kind: 'error', message: 'no such ref' }
    }
    if (sub === 'checkout') return options.checkout ?? { ok: true, stdout: '' }
    if (sub === 'pull') return options.pull ?? { ok: true, stdout: '' }
    throw new Error(`unexpected git subcommand in test: ${sub}`)
  }
  return { git, calls }
}

function makeDeps(
  overrides: Partial<RepoSyncDeps> & { runningPanes?: readonly RunningPaneCwd[] } = {}
): { deps: RepoSyncDeps; showAlertCalls: string[] } {
  const showAlertCalls: string[] = []
  const deps: RepoSyncDeps = {
    git: overrides.git ?? makeFakeGit({}).git,
    listRunningPanes: overrides.listRunningPanes ?? (() => overrides.runningPanes ?? []),
    showAlert:
      overrides.showAlert ??
      (async (message) => {
        showAlertCalls.push(message)
      }),
    repoLock: overrides.repoLock ?? new RepoSyncLock()
  }
  return { deps, showAlertCalls }
}

const CLEAN_ON_DEFAULT: Parameters<typeof makeFakeGit>[0] = {
  branchShowCurrent: { ok: true, stdout: 'main\n' },
  remote: { ok: true, stdout: 'origin\n' },
  forEachRef: { ok: true, stdout: 'main\nfeature-x\n' },
  symbolicRef: { 'refs/remotes/origin/HEAD': { ok: true, stdout: 'refs/remotes/origin/main\n' } }
}

const OFF_DEFAULT_WITH_REMOTE: Parameters<typeof makeFakeGit>[0] = {
  branchShowCurrent: { ok: true, stdout: 'feature-x\n' },
  remote: { ok: true, stdout: 'origin\n' },
  forEachRef: { ok: true, stdout: 'main\nfeature-x\n' },
  symbolicRef: { 'refs/remotes/origin/HEAD': { ok: true, stdout: 'refs/remotes/origin/main\n' } }
}

describe('prepareRepoForLaunch: R-2 repository detection', () => {
  it('returns not-a-repo and never alerts/checks-out/pulls for a non-repo cwd', async () => {
    const { git, calls } = makeFakeGit({
      revParseTopLevelByCwd: {
        'C:\\not-a-repo': {
          ok: false,
          kind: 'error',
          message: 'fatal: not a git repository (or any of the parent directories): .git'
        }
      }
    })
    const { deps, showAlertCalls } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\not-a-repo', deps)

    expect(outcome).toEqual({ kind: 'not-a-repo' })
    expect(showAlertCalls).toEqual([])
    expect(calls.some((c) => c.args[0] === 'checkout' || c.args[0] === 'pull')).toBe(false)
  })

  it('returns git-unavailable on ENOENT and never alerts', async () => {
    const { git } = makeFakeGit({
      revParseTopLevelByCwd: {
        'C:\\repo': { ok: false, kind: 'enoent', message: 'spawn git ENOENT' }
      }
    })
    const { deps, showAlertCalls } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toEqual({ kind: 'git-unavailable', message: 'spawn git ENOENT' })
    expect(showAlertCalls).toEqual([])
  })

  it('FIX minor-C (review iter1): empty rev-parse stdout is reported as failed, not misattributed to process cwd', async () => {
    const { git } = makeFakeGit({
      revParseTopLevelByCwd: { 'C:\\repo': { ok: true, stdout: '   \n' } }
    })
    const { deps } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toMatchObject({ kind: 'failed', step: 'status' })
  })

  it('FIX B4 (review iter1): resolves repoRoot for a cwd that is a subdirectory of the repo, and runs subsequent status/checkout/pull against the resolved root, not the original cwd', async () => {
    const { git, calls } = makeFakeGit({
      revParseTopLevelByCwd: { 'C:\\repo\\sub\\dir': { ok: true, stdout: 'C:/repo\n' } },
      ...OFF_DEFAULT_WITH_REMOTE
    })
    const { deps } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo\\sub\\dir', deps)

    expect(outcome).toMatchObject({ kind: 'synced', repoRoot: 'C:\\repo' })
    const nonTopLevelCalls = calls.filter(
      (c) => !(c.args[0] === 'rev-parse' && c.args[1] === '--show-toplevel')
    )
    expect(nonTopLevelCalls.length).toBeGreaterThan(0)
    for (const call of nonTopLevelCalls) {
      expect(call.cwd).toBe('C:\\repo')
    }
  })
})

describe('prepareRepoForLaunch: R-6/D-7 busy-pane guard (live claude process)', () => {
  it('blocks with blocked-busy (cause=running) and alerts when another running pane resolves to the same repo root, without ever checking out or pulling', async () => {
    const { git, calls } = makeFakeGit({
      revParseTopLevelByCwd: {
        'C:\\repo': { ok: true, stdout: 'C:/repo\n' },
        'C:\\repo\\sub': { ok: true, stdout: 'C:/repo\n' }
      },
      ...OFF_DEFAULT_WITH_REMOTE
    })
    const { deps, showAlertCalls } = makeDeps({
      git,
      runningPanes: [{ pane: 1, cwd: 'C:\\repo\\sub' }]
    })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toEqual({
      kind: 'blocked-busy',
      repoRoot: 'C:\\repo',
      busyPanes: [1],
      cause: 'running',
      requiresSwitch: true
    })
    expect(showAlertCalls).toHaveLength(1)
    expect(showAlertCalls[0]).toContain('C:\\repo')
    expect(calls.some((c) => c.args[0] === 'checkout' || c.args[0] === 'pull')).toBe(false)
  })

  it('does not block on a running pane in a genuinely different repo', async () => {
    const { git } = makeFakeGit({
      revParseTopLevelByCwd: {
        'C:\\repo': { ok: true, stdout: 'C:/repo\n' },
        'C:\\other-repo': { ok: true, stdout: 'C:/other-repo\n' }
      },
      ...CLEAN_ON_DEFAULT
    })
    const { deps } = makeDeps({ git, runningPanes: [{ pane: 2, cwd: 'C:\\other-repo' }] })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome.kind).not.toBe('blocked-busy')
  })

  it('FIX B2 (review iter2, reverting iter1 FIX M6): DOES block (blocked-busy) even when already on the default branch and clean -- D-7 is unconditional again, but no modal fires (requiresSwitch=false) and no git call is even attempted', async () => {
    const { git, calls } = makeFakeGit({
      revParseTopLevelByCwd: {
        'C:\\repo': { ok: true, stdout: 'C:/repo\n' },
        'C:\\repo\\sub': { ok: true, stdout: 'C:/repo\n' }
      },
      ...CLEAN_ON_DEFAULT
    })
    const { deps, showAlertCalls } = makeDeps({
      git,
      runningPanes: [{ pane: 1, cwd: 'C:\\repo\\sub' }]
    })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toEqual({
      kind: 'blocked-busy',
      repoRoot: 'C:\\repo',
      busyPanes: [1],
      cause: 'running',
      requiresSwitch: false
    })
    expect(showAlertCalls).toEqual([]) // no modal -- a checkout was never going to happen anyway
    expect(calls.some((c) => c.args[0] === 'pull')).toBe(false)
    expect(calls.some((c) => c.args[0] === 'checkout')).toBe(false)
  })

  it('FIX M3 (review iter2): a busy-pane candidate whose own rev-parse times out is treated as busy (safe side), not as "different repo"', async () => {
    const { git } = makeFakeGit({
      revParseTopLevelByCwd: {
        'C:\\repo': { ok: true, stdout: 'C:/repo\n' },
        'C:\\repo\\sub': {
          ok: false,
          kind: 'timeout',
          message: 'git rev-parse timed out after 5000ms'
        }
      },
      ...OFF_DEFAULT_WITH_REMOTE
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { deps } = makeDeps({ git, runningPanes: [{ pane: 1, cwd: 'C:\\repo\\sub' }] })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toMatchObject({ kind: 'blocked-busy', busyPanes: [1] })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('FIX M3 (review iter2): a busy-pane candidate confirmed as "not a git repository" is genuinely not-busy', async () => {
    const { git } = makeFakeGit({
      revParseTopLevelByCwd: {
        'C:\\repo': { ok: true, stdout: 'C:/repo\n' },
        'C:\\not-a-repo-cwd': {
          ok: false,
          kind: 'error',
          message: 'fatal: not a git repository (or any of the parent directories): .git'
        }
      },
      ...CLEAN_ON_DEFAULT
    })
    const { deps } = makeDeps({ git, runningPanes: [{ pane: 1, cwd: 'C:\\not-a-repo-cwd' }] })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome.kind).not.toBe('blocked-busy')
  })

  it("FIX M4 (review iter2): a busy-pane candidate with empty rev-parse stdout is treated as busy (safe side), not misattributed to this process's own cwd", async () => {
    const { git } = makeFakeGit({
      revParseTopLevelByCwd: {
        'C:\\repo': { ok: true, stdout: 'C:/repo\n' },
        'C:\\repo\\sub': { ok: true, stdout: '   \n' }
      },
      ...OFF_DEFAULT_WITH_REMOTE
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { deps } = makeDeps({ git, runningPanes: [{ pane: 1, cwd: 'C:\\repo\\sub' }] })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toMatchObject({ kind: 'blocked-busy', busyPanes: [1] })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('prepareRepoForLaunch: FIX M2 (review iter1/iter2) in-flight repo lock', () => {
  it('a second concurrent launch for the same repo blocks (blocked-busy, cause=launching) without racing on checkout/pull, and the first launch still completes normally', async () => {
    const lock = new RepoSyncLock()
    // A manually-resolvable Promise<GitCliResult>, as a plain object rather than a `let` reassigned from
    // inside the executor closure -- TypeScript's control-flow analysis narrows a closure-reassigned `let`
    // to `never` at the read site in this exact shape (reproduced in isolation).
    const statusBox: { resolve: ((result: GitCliResult) => void) | null } = { resolve: null }
    const statusPromise = new Promise<GitCliResult>((resolve) => {
      statusBox.resolve = resolve
    })
    const calls: GitCall[] = []
    const git: RepoSyncDeps['git'] = async (args, cwd, timeoutMs) => {
      calls.push({ args: [...args], cwd, timeoutMs })
      const sub = args[0]
      if (sub === 'rev-parse' && args[1] === '--show-toplevel')
        return { ok: true, stdout: 'C:/repo\n' }
      if (sub === 'status') return statusPromise
      return { ok: true, stdout: '' }
    }
    const { deps } = makeDeps({ git, repoLock: lock })

    const firstPromise = prepareRepoForLaunch(0, 'C:\\repo', deps)
    // Let the first call's microtasks run through claiming the lock and issuing its status call, without
    // letting it finish (status is still pending on the manually-controlled promise above).
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lock.holderPane('C:\\repo')).toBe(0)

    const secondOutcome = await prepareRepoForLaunch(1, 'C:\\repo', deps)
    expect(secondOutcome).toEqual({
      kind: 'blocked-busy',
      repoRoot: 'C:\\repo',
      busyPanes: [0],
      cause: 'launching',
      requiresSwitch: true
    })
    expect(calls.filter((c) => c.args[0] === 'status')).toHaveLength(1) // the second call never reached it

    statusBox.resolve?.({ ok: true, stdout: '' })
    const firstOutcome = await firstPromise
    expect(firstOutcome.kind).not.toBe('blocked-busy')
    expect(lock.holderPane('C:\\repo')).toBeNull() // released once the first call finished
  })

  it('does not lock/block a second launch for a genuinely different repo', async () => {
    const lock = new RepoSyncLock()
    const { git: gitA } = makeFakeGit({
      revParseTopLevelByCwd: { 'C:\\repo-a': { ok: true, stdout: 'C:/repo-a\n' } },
      ...CLEAN_ON_DEFAULT
    })
    const { git: gitB } = makeFakeGit({
      revParseTopLevelByCwd: { 'C:\\repo-b': { ok: true, stdout: 'C:/repo-b\n' } },
      ...CLEAN_ON_DEFAULT
    })
    const { deps: depsA } = makeDeps({ git: gitA, repoLock: lock })
    const { deps: depsB } = makeDeps({ git: gitB, repoLock: lock })

    const [outcomeA, outcomeB] = await Promise.all([
      prepareRepoForLaunch(0, 'C:\\repo-a', depsA),
      prepareRepoForLaunch(1, 'C:\\repo-b', depsB)
    ])

    expect(outcomeA.kind).not.toBe('blocked-busy')
    expect(outcomeB.kind).not.toBe('blocked-busy')
  })
})

describe('prepareRepoForLaunch: R-3 uncommitted-change guard (U-1 confirmed: untracked alone blocks)', () => {
  it('blocks on tracked changes, reporting changedCount + samplePaths + currentBranch, never checking out/pulling', async () => {
    const { git, calls } = makeFakeGit({
      status: { ok: true, stdout: 'M  file.txt\0' },
      ...OFF_DEFAULT_WITH_REMOTE
    })
    const { deps, showAlertCalls } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toEqual({
      kind: 'blocked-dirty',
      repoRoot: 'C:\\repo',
      changedCount: 1,
      samplePaths: ['file.txt'],
      currentBranch: 'feature-x'
    })
    expect(showAlertCalls[0]).toContain('file.txt')
    expect(calls.some((c) => c.args[0] === 'checkout' || c.args[0] === 'pull')).toBe(false)
  })

  it('blocks on untracked-only changes (U-1 案A)', async () => {
    const { git } = makeFakeGit({ status: { ok: true, stdout: '?? new-file.txt\0' } })
    const { deps, showAlertCalls } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toMatchObject({ kind: 'blocked-dirty', changedCount: 1 })
    expect(showAlertCalls).toHaveLength(1)
  })

  it('truncates samplePaths to the first few while changedCount reflects the full total', async () => {
    const stdout = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((f) => `?? ${f}.txt\0`).join('')
    const { git } = makeFakeGit({ status: { ok: true, stdout } })
    const { deps } = makeDeps({ git })

    const outcome = (await prepareRepoForLaunch(0, 'C:\\repo', deps)) as Extract<
      RepoSyncOutcome,
      { kind: 'blocked-dirty' }
    >

    expect(outcome.changedCount).toBe(7)
    expect(outcome.samplePaths).toHaveLength(5)
  })

  it('FIX B1 (review iter1): dirty takes priority over busy in actual runtime behavior (not just in the pure planRepoSync unit tests) -- the commit-prompt alert fires even when another pane is also busy in the same repo', async () => {
    const { git } = makeFakeGit({
      revParseTopLevelByCwd: {
        'C:\\repo': { ok: true, stdout: 'C:/repo\n' },
        'C:\\repo\\sub': { ok: true, stdout: 'C:/repo\n' }
      },
      status: { ok: true, stdout: 'M  file.txt\0' },
      ...OFF_DEFAULT_WITH_REMOTE
    })
    const { deps, showAlertCalls } = makeDeps({
      git,
      runningPanes: [{ pane: 1, cwd: 'C:\\repo\\sub' }]
    })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome.kind).toBe('blocked-dirty')
    expect(showAlertCalls[0]).toContain('未コミット')
  })
})

describe('prepareRepoForLaunch: FIX B2 (review iter1) branch/remote/local-branches query failures', () => {
  it('reports failed/status (never checkout/pull) when `git branch --show-current` fails, instead of silently treating it as detached HEAD', async () => {
    const { git, calls } = makeFakeGit({
      branchShowCurrent: {
        ok: false,
        kind: 'timeout',
        message: 'git branch timed out after 5000ms'
      }
    })
    const { deps } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toEqual({
      kind: 'failed',
      repoRoot: 'C:\\repo',
      step: 'status',
      message: 'git branch timed out after 5000ms'
    })
    expect(calls.some((c) => c.args[0] === 'checkout' || c.args[0] === 'pull')).toBe(false)
  })

  it('reports failed/status when `git remote` fails, instead of silently treating it as "no remote configured" and moving the branch anyway', async () => {
    const { git, calls } = makeFakeGit({
      branchShowCurrent: { ok: true, stdout: 'feature-x\n' },
      remote: { ok: false, kind: 'error', message: 'fatal: unable to read config' }
    })
    const { deps } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toEqual({
      kind: 'failed',
      repoRoot: 'C:\\repo',
      step: 'status',
      message: 'fatal: unable to read config'
    })
    expect(calls.some((c) => c.args[0] === 'checkout' || c.args[0] === 'pull')).toBe(false)
  })

  it('reports failed/status when `git for-each-ref` fails', async () => {
    const { git } = makeFakeGit({
      branchShowCurrent: { ok: true, stdout: 'feature-x\n' },
      remote: { ok: true, stdout: '' },
      forEachRef: { ok: false, kind: 'error', message: 'fatal: bad ref pattern' }
    })
    const { deps } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toMatchObject({
      kind: 'failed',
      step: 'status',
      message: 'fatal: bad ref pattern'
    })
  })
})

describe('prepareRepoForLaunch: R-4/R-5 default-branch resolution and sync execution', () => {
  it('checkout-and-pull when off the default branch with a remote (exact args pinned, R-5)', async () => {
    const { git, calls } = makeFakeGit(OFF_DEFAULT_WITH_REMOTE)
    const { deps } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toEqual({
      kind: 'synced',
      repoRoot: 'C:\\repo',
      branch: 'main',
      switched: true,
      pulled: true,
      fromBranch: 'feature-x',
      pullSkippedReason: null
    })
    const statusCall = calls.find((c) => c.args[0] === 'status')
    const checkoutCall = calls.find((c) => c.args[0] === 'checkout')
    const pullCall = calls.find((c) => c.args[0] === 'pull')
    // R-3: --ignored is never passed (ignored files stay invisible to this check, spec's own requirement).
    expect(statusCall?.args).toEqual(['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
    expect(checkoutCall?.args).toEqual(['checkout', 'main'])
    expect(checkoutCall?.timeoutMs).toBe(GIT_TIMEOUT_MS.checkout)
    expect(pullCall?.args).toEqual(['pull', '--ff-only']) // R-5: not --rebase, not bare pull
    expect(pullCall?.timeoutMs).toBe(GIT_TIMEOUT_MS.pull)
    // checkout must run before pull.
    expect(calls.indexOf(checkoutCall!)).toBeLessThan(calls.indexOf(pullCall!))
  })

  it('pull-only (no checkout call at all) when already on the default branch with a remote', async () => {
    const { git, calls } = makeFakeGit(CLEAN_ON_DEFAULT)
    const { deps } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toEqual({
      kind: 'synced',
      repoRoot: 'C:\\repo',
      branch: 'main',
      switched: false,
      pulled: true,
      pullSkippedReason: null
    })
    expect(calls.some((c) => c.args[0] === 'checkout')).toBe(false)
  })

  it('switch-only (checkout but never pull) when off the default branch with no remote configured', async () => {
    const { git, calls } = makeFakeGit({
      branchShowCurrent: { ok: true, stdout: 'feature-x\n' },
      remote: { ok: true, stdout: '' },
      forEachRef: { ok: true, stdout: 'main\nfeature-x\n' }
    })
    const { deps } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toEqual({
      kind: 'synced',
      repoRoot: 'C:\\repo',
      branch: 'main',
      switched: true,
      fromBranch: 'feature-x',
      pulled: false,
      pullSkippedReason: 'remote が未設定のため'
    })
    expect(calls.some((c) => c.args[0] === 'pull')).toBe(false)
  })

  it('skips (never checks out) when the default branch cannot be resolved', async () => {
    const { git, calls } = makeFakeGit({
      branchShowCurrent: { ok: true, stdout: 'feature-x\n' },
      remote: { ok: true, stdout: '' },
      forEachRef: { ok: true, stdout: 'feature-x\ndev\n' } // no main, no master
    })
    const { deps } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome.kind).toBe('skipped')
    expect(calls.some((c) => c.args[0] === 'checkout' || c.args[0] === 'pull')).toBe(false)
  })

  it('skips when already on the default branch with no remote (truly nothing to do)', async () => {
    const { git } = makeFakeGit({
      branchShowCurrent: { ok: true, stdout: 'main\n' },
      remote: { ok: true, stdout: '' },
      forEachRef: { ok: true, stdout: 'main\n' }
    })
    const { deps } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome.kind).toBe('skipped')
  })

  it('never performs a `git remote show` (no network round-trip, D-5)', async () => {
    const { git, calls } = makeFakeGit(CLEAN_ON_DEFAULT)
    const { deps } = makeDeps({ git })

    await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(calls.some((c) => c.args[0] === 'remote' && c.args[1] === 'show')).toBe(false)
  })
})

describe('prepareRepoForLaunch: FIX M4/M1 (review iter1/iter2) missing-upstream handling', () => {
  it('pull-only + no upstream -> synced{switched:false, pulled:false} with a reason (not skipped, not failed), pull is never attempted', async () => {
    const { git, calls } = makeFakeGit({
      ...CLEAN_ON_DEFAULT,
      upstream: {
        ok: false,
        kind: 'error',
        message: "fatal: no upstream configured for branch 'main'"
      }
    })
    const { deps } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toMatchObject({
      kind: 'synced',
      branch: 'main',
      switched: false,
      pulled: false
    })
    expect((outcome as { pullSkippedReason: string }).pullSkippedReason).toContain('upstream')
    expect(calls.some((c) => c.args[0] === 'pull')).toBe(false)
  })

  it('checkout-and-pull + no upstream -> checkout still runs, and the outcome is synced{switched:true, pulled:false} (not skipped -- the branch move must not be hidden behind "skipped")', async () => {
    const { git, calls } = makeFakeGit({
      ...OFF_DEFAULT_WITH_REMOTE,
      upstream: {
        ok: false,
        kind: 'error',
        message: "fatal: no upstream configured for branch 'main'"
      }
    })
    const { deps } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toMatchObject({
      kind: 'synced',
      branch: 'main',
      switched: true,
      fromBranch: 'feature-x',
      pulled: false
    })
    expect((outcome as { pullSkippedReason: string }).pullSkippedReason).toContain('upstream')
    expect(calls.some((c) => c.args[0] === 'checkout')).toBe(true)
    expect(calls.some((c) => c.args[0] === 'pull')).toBe(false)
  })
})

describe('prepareRepoForLaunch: failure handling (R-4/R-5/R-7/R-9)', () => {
  it('reports checkout failure as failed/checkout and never attempts the upstream check or pull', async () => {
    const { git, calls } = makeFakeGit({
      ...OFF_DEFAULT_WITH_REMOTE,
      checkout: {
        ok: false,
        kind: 'error',
        message: 'error: Your local changes would be overwritten'
      }
    })
    const { deps } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toEqual({
      kind: 'failed',
      repoRoot: 'C:\\repo',
      step: 'checkout',
      message: 'error: Your local changes would be overwritten'
    })
    expect(calls.some((c) => c.args[0] === 'pull')).toBe(false)
  })

  it('reports a non-fast-forward pull failure as failed/pull with the git stderr', async () => {
    const { git } = makeFakeGit({
      ...CLEAN_ON_DEFAULT,
      pull: { ok: false, kind: 'error', message: 'fatal: Not possible to fast-forward' }
    })
    const { deps } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toEqual({
      kind: 'failed',
      repoRoot: 'C:\\repo',
      step: 'pull',
      message: 'fatal: Not possible to fast-forward'
    })
  })

  it('reports a timed-out status query as failed rather than throwing', async () => {
    const { git } = makeFakeGit({
      status: { ok: false, kind: 'timeout', message: 'git status timed out after 5000ms' }
    })
    const { deps } = makeDeps({ git })

    const outcome = await prepareRepoForLaunch(0, 'C:\\repo', deps)

    expect(outcome).toEqual({
      kind: 'failed',
      repoRoot: 'C:\\repo',
      step: 'status',
      message: 'git status timed out after 5000ms'
    })
  })

  it('catches an unexpected thrown exception and reports it as failed instead of propagating (R-9)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { deps } = makeDeps({
      git: () => {
        throw new Error('unexpected bug')
      }
    })

    await expect(prepareRepoForLaunch(0, 'C:\\repo', deps)).resolves.toMatchObject({
      kind: 'failed',
      message: 'unexpected bug'
    })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
