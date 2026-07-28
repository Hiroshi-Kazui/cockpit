// Behavioral tests for the M11 git-sync pure decision layer (spec §4.2 launch flow addendum, ADR-0013).
// Written test-first (CLAUDE.md: shared/ is test-first) -- these must fail (red) against a not-yet-existing
// ./gitSync module before any implementation is written.
import { describe, expect, it } from 'vitest'
import {
  areSameRepoRoot,
  describeRepoSyncOutcome,
  extractBranchFromRemoteHeadRef,
  parsePorcelainStatus,
  planRepoSync,
  resolveDefaultBranch,
  type DefaultBranchResolution
} from './gitSync'
import type { RepoSyncOutcome } from './ipc'

describe('parsePorcelainStatus', () => {
  it('treats empty output as a clean worktree', () => {
    expect(parsePorcelainStatus('')).toEqual({
      entries: [],
      hasTrackedChanges: false,
      hasUntracked: false
    })
  })

  it('detects an untracked-only file as hasUntracked=true, hasTrackedChanges=false (U-1 confirmed=案A)', () => {
    const result = parsePorcelainStatus('?? new-file.txt\0')
    expect(result.hasUntracked).toBe(true)
    expect(result.hasTrackedChanges).toBe(false)
    expect(result.entries).toEqual([{ code: '??', path: 'new-file.txt' }])
  })

  it.each([' M path', 'M  path', 'MM path', 'D  path', 'UU path'])(
    'detects tracked-change code %s as hasTrackedChanges=true',
    (record) => {
      const result = parsePorcelainStatus(`${record}\0`)
      expect(result.hasTrackedChanges).toBe(true)
      expect(result.hasUntracked).toBe(false)
    }
  )

  it('consumes the extra NUL-terminated field for a rename without shifting later entries', () => {
    const stdout = 'R  new.txt\0old.txt\0M  other.txt\0'
    const result = parsePorcelainStatus(stdout)
    expect(result.entries).toEqual([
      { code: 'R ', path: 'new.txt' },
      { code: 'M ', path: 'other.txt' }
    ])
    expect(result.hasTrackedChanges).toBe(true)
  })

  it('treats an unrecognized status code as "changes present" (tolerant parser, never loses information)', () => {
    const result = parsePorcelainStatus('Z  mystery.txt\0')
    expect(result.hasTrackedChanges).toBe(true)
  })

  it('a worktree with only .gitignore-excluded files (never emitted without --ignored) is clean', () => {
    // shouldRetainLine-style: simply nothing is emitted for ignored files since --ignored is never passed.
    expect(parsePorcelainStatus('').hasTrackedChanges).toBe(false)
    expect(parsePorcelainStatus('').hasUntracked).toBe(false)
  })
})

describe('resolveDefaultBranch (D-5)', () => {
  it('adopts the branch that refs/remotes/origin/HEAD points to', () => {
    const result = resolveDefaultBranch({
      remoteHeads: { origin: 'main' },
      remotes: ['origin', 'upstream'],
      localBranches: ['main', 'feature-x']
    })
    expect(result).toEqual({ resolved: true, branch: 'main' })
  })

  it("falls back to the sole remote's HEAD when there is no origin and exactly one remote", () => {
    const result = resolveDefaultBranch({
      remoteHeads: { fork: 'trunk' },
      remotes: ['fork'],
      localBranches: []
    })
    expect(result).toEqual({ resolved: true, branch: 'trunk' })
  })

  it('does not guess when there is no origin and multiple remotes (ambiguous)', () => {
    const result = resolveDefaultBranch({
      remoteHeads: { fork1: 'trunk', fork2: 'trunk' },
      remotes: ['fork1', 'fork2'],
      localBranches: ['main']
    })
    // No remote is authoritative -- falls through to local main.
    expect(result).toEqual({ resolved: true, branch: 'main' })
  })

  it('falls back to local main when no remote HEAD resolves', () => {
    const result = resolveDefaultBranch({
      remoteHeads: {},
      remotes: [],
      localBranches: ['main', 'dev']
    })
    expect(result).toEqual({ resolved: true, branch: 'main' })
  })

  it('falls back to local master when main does not exist', () => {
    const result = resolveDefaultBranch({
      remoteHeads: {},
      remotes: [],
      localBranches: ['master', 'dev']
    })
    expect(result).toEqual({ resolved: true, branch: 'master' })
  })

  it('returns resolved=false (never throws/guesses) when nothing resolves', () => {
    const result = resolveDefaultBranch({ remoteHeads: {}, remotes: [], localBranches: ['dev'] })
    expect(result).toEqual({ resolved: false })
  })
})

describe('extractBranchFromRemoteHeadRef', () => {
  it('extracts the branch name from a refs/remotes/<remote>/HEAD target', () => {
    expect(extractBranchFromRemoteHeadRef('refs/remotes/origin/main', 'origin')).toBe('main')
  })

  it('handles a branch name that itself contains slashes', () => {
    expect(extractBranchFromRemoteHeadRef('refs/remotes/origin/release/1.0', 'origin')).toBe(
      'release/1.0'
    )
  })

  it('returns null for a ref that does not match the expected remote prefix', () => {
    expect(extractBranchFromRemoteHeadRef('refs/remotes/upstream/main', 'origin')).toBeNull()
  })

  it('returns null for malformed input', () => {
    expect(extractBranchFromRemoteHeadRef('', 'origin')).toBeNull()
    expect(extractBranchFromRemoteHeadRef('refs/remotes/origin/', 'origin')).toBeNull()
  })
})

describe('normalizeRepoRootForComparison / areSameRepoRoot (R-6, Windows path normalization)', () => {
  it('treats differing separators and case as the same root', () => {
    expect(areSameRepoRoot('C:/develop/x', 'C:\\develop\\X')).toBe(true)
  })

  it('treats genuinely different roots as different', () => {
    expect(areSameRepoRoot('C:/develop/x', 'C:/develop/y')).toBe(false)
  })

  it('is insensitive to a trailing separator', () => {
    expect(areSameRepoRoot('C:\\develop\\x\\', 'C:/develop/x')).toBe(true)
  })
})

describe('planRepoSync', () => {
  const resolvedMain: DefaultBranchResolution = { resolved: true, branch: 'main' }
  const unresolved: DefaultBranchResolution = { resolved: false }
  const base = {
    hasTrackedChanges: false,
    hasUntracked: false,
    busyPanes: [] as const,
    currentBranch: 'feature-x',
    defaultBranch: resolvedMain,
    hasRemote: true
  }

  it('blocks (block-dirty) when there are tracked changes, even with no untracked files', () => {
    expect(planRepoSync({ ...base, hasTrackedChanges: true })).toEqual({ action: 'block-dirty' })
  })

  it('blocks (block-dirty) on untracked-only changes (U-1 confirmed=案A: untracked alone blocks)', () => {
    expect(planRepoSync({ ...base, hasUntracked: true })).toEqual({ action: 'block-dirty' })
  })

  it('FIX B2 (review iter2, reverting iter1 FIX M6): blocks (block-busy) unconditionally when another pane is busy, even off the default branch (requiresSwitch=true)', () => {
    expect(planRepoSync({ ...base, busyPanes: [1] })).toEqual({
      action: 'block-busy',
      requiresSwitch: true
    })
  })

  it('block-dirty takes priority over block-busy when both apply', () => {
    expect(planRepoSync({ ...base, hasUntracked: true, busyPanes: [1] })).toEqual({
      action: 'block-dirty'
    })
  })

  it('skips (with a reason) when the default branch cannot be resolved -- never guesses', () => {
    const result = planRepoSync({ ...base, defaultBranch: unresolved })
    expect(result.action).toBe('skip')
    expect((result as { reason: string }).reason.length).toBeGreaterThan(0)
  })

  it("FIX B2 (review iter2): blocks (block-busy) even when the default branch cannot be resolved -- busy is unconditional again. requiresSwitch defaults to true (safe side) since whether a switch would have happened can't be determined without a resolved target", () => {
    const result = planRepoSync({ ...base, defaultBranch: unresolved, busyPanes: [1] })
    expect(result).toEqual({ action: 'block-busy', requiresSwitch: true })
  })

  it('checkout-and-pull when off the default branch and a remote exists', () => {
    expect(planRepoSync(base)).toEqual({ action: 'checkout-and-pull', targetBranch: 'main' })
  })

  it('switch-only (no pull) when off the default branch and no remote is configured', () => {
    expect(planRepoSync({ ...base, hasRemote: false })).toEqual({
      action: 'switch-only',
      targetBranch: 'main'
    })
  })

  it('pull-only (no checkout) when already on the default branch and a remote exists', () => {
    expect(planRepoSync({ ...base, currentBranch: 'main' })).toEqual({
      action: 'pull-only',
      targetBranch: 'main'
    })
  })

  it('FIX B2 (review iter2, reverting iter1 FIX M6): DOES block (block-busy, requiresSwitch=false) even when already on the default branch and clean -- D-7 is unconditional again; requiresSwitch just tells the caller no checkout would have run', () => {
    expect(planRepoSync({ ...base, currentBranch: 'main', busyPanes: [1] })).toEqual({
      action: 'block-busy',
      requiresSwitch: false
    })
  })

  it('skips when already on the default branch and no remote is configured (nothing to do)', () => {
    const result = planRepoSync({ ...base, currentBranch: 'main', hasRemote: false })
    expect(result.action).toBe('skip')
  })

  it('treats a detached HEAD (currentBranch=null) as not-on-default-branch', () => {
    expect(planRepoSync({ ...base, currentBranch: null })).toEqual({
      action: 'checkout-and-pull',
      targetBranch: 'main'
    })
  })

  it('blocks (block-busy, requiresSwitch=true) on a detached HEAD when off the default branch (a switch is still needed)', () => {
    expect(planRepoSync({ ...base, currentBranch: null, busyPanes: [1] })).toEqual({
      action: 'block-busy',
      requiresSwitch: true
    })
  })
})

describe('describeRepoSyncOutcome (R-8: Japanese, kind-specific, no silent failure)', () => {
  it('not-a-repo', () => {
    expect(describeRepoSyncOutcome({ kind: 'not-a-repo' })).toMatch(/git リポジトリ/)
  })

  it('git-unavailable includes the message', () => {
    const text = describeRepoSyncOutcome({ kind: 'git-unavailable', message: 'spawn git ENOENT' })
    expect(text).toContain('spawn git ENOENT')
  })

  it('blocked-dirty includes the repo path, changed count, and sample paths', () => {
    const outcome: RepoSyncOutcome = {
      kind: 'blocked-dirty',
      repoRoot: 'C:\\repo',
      changedCount: 3,
      samplePaths: ['a.txt', 'b.txt'],
      currentBranch: 'feature-x'
    }
    const text = describeRepoSyncOutcome(outcome)
    expect(text).toContain('C:\\repo')
    expect(text).toContain('3')
    expect(text).toContain('a.txt')
    expect(text).toContain('b.txt')
  })

  it('FIX B1 (review iter2): blocked-dirty prompts a commit (restores the requirement\'s literal "commit を促す" wording, lost in iter1\'s FIX M5)', () => {
    const text = describeRepoSyncOutcome({
      kind: 'blocked-dirty',
      repoRoot: 'C:\\repo',
      changedCount: 1,
      samplePaths: ['a.txt'],
      currentBranch: 'feature-x'
    })
    expect(text).toContain('commit')
  })

  it('blocked-dirty also still says the session starts on the current branch regardless (D-2/R-9)', () => {
    const text = describeRepoSyncOutcome({
      kind: 'blocked-dirty',
      repoRoot: 'C:\\repo',
      changedCount: 1,
      samplePaths: ['a.txt'],
      currentBranch: 'feature-x'
    })
    expect(text).toContain('feature-x')
  })

  it('blocked-dirty tolerates a detached HEAD (currentBranch=null)', () => {
    const text = describeRepoSyncOutcome({
      kind: 'blocked-dirty',
      repoRoot: 'C:\\repo',
      changedCount: 1,
      samplePaths: ['a.txt'],
      currentBranch: null
    })
    expect(text.length).toBeGreaterThan(0)
  })

  it('FIX C (review iter2): blocked-dirty puts the branch-continuation note ahead of the repo path (so a single-line truncation keeps it visible)', () => {
    const text = describeRepoSyncOutcome({
      kind: 'blocked-dirty',
      repoRoot: 'C:\\repo',
      changedCount: 1,
      samplePaths: ['a.txt'],
      currentBranch: 'feature-x'
    })
    const firstLine = text.split('\n')[0]
    expect(firstLine.indexOf('feature-x')).toBeLessThan(firstLine.indexOf('C:\\repo'))
  })

  it('blocked-busy (cause=running) mentions the busy pane and claude', () => {
    const text = describeRepoSyncOutcome({
      kind: 'blocked-busy',
      repoRoot: 'C:\\repo',
      busyPanes: [1],
      cause: 'running',
      requiresSwitch: true
    })
    expect(text).toContain('C:\\repo')
    expect(text).toMatch(/ペイン2/) // 1-indexed display of PaneIndex 1
    expect(text).toContain('claude')
  })

  it('FIX M2 (review iter2): blocked-busy (cause=launching) describes an in-flight git sync, not a running claude, and suggests retrying', () => {
    const text = describeRepoSyncOutcome({
      kind: 'blocked-busy',
      repoRoot: 'C:\\repo',
      busyPanes: [0],
      cause: 'launching',
      requiresSwitch: true
    })
    expect(text).toContain('git 同期')
    expect(text).not.toContain('claude が実行中')
    expect(text).toMatch(/もう一度/)
  })

  it('skipped includes the reason', () => {
    expect(
      describeRepoSyncOutcome({ kind: 'skipped', reason: 'デフォルトブランチ不明' })
    ).toContain('デフォルトブランチ不明')
  })

  it('synced with a branch switch includes "元→先" (fromBranch -> branch)', () => {
    const text = describeRepoSyncOutcome({
      kind: 'synced',
      repoRoot: 'C:\\repo',
      branch: 'main',
      switched: true,
      pulled: true,
      fromBranch: 'feature-x',
      pullSkippedReason: null
    })
    expect(text).toContain('feature-x')
    expect(text).toContain('main')
  })

  it('synced without a switch (pull-only) does not claim a move happened', () => {
    const text = describeRepoSyncOutcome({
      kind: 'synced',
      repoRoot: 'C:\\repo',
      branch: 'main',
      switched: false,
      pulled: true,
      pullSkippedReason: null
    })
    expect(text).toContain('main')
  })

  it('FIX M1 (review iter2): synced with switched=true and pulled=false states the pull-skip reason instead of being reported as "skipped" (self-contradiction fix)', () => {
    const text = describeRepoSyncOutcome({
      kind: 'synced',
      repoRoot: 'C:\\repo',
      branch: 'main',
      switched: true,
      pulled: false,
      fromBranch: 'feature-x',
      pullSkippedReason: 'main に upstream が設定されていないため'
    })
    expect(text).toContain('feature-x')
    expect(text).toContain('main')
    expect(text).toContain('upstream が設定されていないため')
    expect(text).not.toContain('スキップしました:')
  })

  it('synced with switched=false and pulled=false also states the pull-skip reason (e.g. no remote configured)', () => {
    const text = describeRepoSyncOutcome({
      kind: 'synced',
      repoRoot: 'C:\\repo',
      branch: 'main',
      switched: false,
      pulled: false,
      pullSkippedReason: 'remote が未設定のため'
    })
    expect(text).toContain('remote が未設定のため')
  })

  it('failed includes the step and message, plus a Japanese lead sentence and next action (FIX M9)', () => {
    const text = describeRepoSyncOutcome({
      kind: 'failed',
      repoRoot: 'C:\\repo',
      step: 'pull',
      message: 'non-fast-forward'
    })
    expect(text).toContain('pull')
    expect(text).toContain('non-fast-forward')
    expect(text).toMatch(/git 同期/)
    expect(text).toContain('git pull') // next-action suggestion, distinct from the raw detail line
  })

  it.each(['status', 'checkout', 'pull'] as const)(
    'failed/%s always includes a Japanese step label distinct from the raw message',
    (step) => {
      const text = describeRepoSyncOutcome({
        kind: 'failed',
        repoRoot: 'C:\\repo',
        step,
        message: 'some raw git stderr'
      })
      expect(text).toContain('詳細: some raw git stderr')
    }
  )
})
