// Pure decision layer for the M11 git working-tree sync on new-session launch (spec §4.2 addendum,
// ADR-0013). Parses `git status --porcelain` output, resolves the repository's default branch from
// already-gathered local information, decides what (if anything) main/git/repoSync.ts should do to the
// worktree, and renders the Japanese text shown to the user. No fs/child_process/Electron here (CLAUDE.md:
// shared/ 純関数, test-first) -- every git invocation and every dialog happens in main/git/*.
//
// Deliberately no `node:path` import either (unlike e.g. shared/paths.ts/mirrorPlan.ts): describeRepoSyncOutcome
// is imported by Pane.tsx (renderer), and electron-vite externalizes Node built-ins out of the browser
// bundle, which would make any of *this* module's exports that touched `path.resolve` throw at runtime if
// ever called from renderer code. normalizeRepoRootForComparison below only ever compares two already-
// absolute paths (a `git rev-parse --show-toplevel` result or a user-chosen folder-dialog path, never a
// relative segment in practice), so plain string normalization is sufficient and keeps this module
// portable to either process.
import type { PaneIndex, RepoSyncOutcome } from './ipc'

// ---- git status --porcelain=v1 -z parsing (D-4/U-1) ----

export interface WorktreeStatusEntry {
  /** The raw 2-character XY status code (e.g. '??', ' M', 'MM', 'R '). */
  code: string
  path: string
}

export interface WorktreeStatus {
  entries: WorktreeStatusEntry[]
  /** Any entry other than '??' (staged or unstaged modification to a tracked file). */
  hasTrackedChanges: boolean
  /** Any '??' entry (untracked file). U-1 (confirmed 2026-07-28, 案A): this alone blocks a launch. */
  hasUntracked: boolean
}

/**
 * Parses `git status --porcelain=v1 -z --untracked-files=normal` output (ADR-0013/D-4). NUL-separated
 * records: each ordinary entry is one `"XY path"` token; a rename/copy entry (X or Y is 'R'/'C') is
 * followed by one extra bare-path token that must be consumed without being treated as its own entry, or
 * every later entry would parse one field out of alignment. Unknown/unrecognized status codes are
 * conservatively treated as "changes present" (tracked side) -- this parser never discards information it
 * cannot classify (spec §7's general "未知は保持側に倒す" tolerance, applied here to status codes).
 */
export function parsePorcelainStatus(stdout: string): WorktreeStatus {
  const entries: WorktreeStatusEntry[] = []
  const tokens = stdout.split('\0')
  let hasTrackedChanges = false
  let hasUntracked = false

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.length === 0) continue // trailing empty token after the final NUL (or fully empty stdout)
    const code = token.slice(0, 2)
    const entryPath = token.slice(3)
    entries.push({ code, path: entryPath })

    if (code === '??') {
      hasUntracked = true
    } else {
      hasTrackedChanges = true
    }

    if (code[0] === 'R' || code[1] === 'R' || code[0] === 'C' || code[1] === 'C') {
      // Rename/copy: the next token is the other (old/new) path, not a separate entry -- skip it.
      i++
    }
  }

  return { entries, hasTrackedChanges, hasUntracked }
}

// ---- default branch resolution (D-5) ----

export type DefaultBranchResolution = { resolved: true; branch: string } | { resolved: false }

export interface ResolveDefaultBranchInput {
  /** For each remote name in `remotes` that was queried, the branch name `refs/remotes/<remote>/HEAD`
   * resolves to (already extracted via extractBranchFromRemoteHeadRef below), or null if it could not be
   * resolved for that remote. Remotes never worth consulting per D-5 (i.e. everything except origin, or a
   * sole non-origin remote) need not be present here -- the caller only has to have queried the remote(s)
   * this function will actually look at. */
  remoteHeads: Readonly<Record<string, string | null>>
  remotes: readonly string[]
  localBranches: readonly string[]
}

/**
 * D-5: `refs/remotes/<remote>/HEAD` (origin preferred; the sole remote if there is no origin and exactly
 * one remote -- otherwise no remote is authoritative) → local `main` → local `master` → unresolved. Never
 * performs a network round-trip itself (it only reads what the caller already gathered) and never guesses
 * past the last rule -- an unresolved result is returned explicitly rather than falling back to some
 * arbitrary branch.
 */
export function resolveDefaultBranch(input: ResolveDefaultBranchInput): DefaultBranchResolution {
  const remote = input.remotes.includes('origin')
    ? 'origin'
    : input.remotes.length === 1
      ? input.remotes[0]
      : null
  if (remote !== null) {
    const branch = input.remoteHeads[remote]
    if (branch) return { resolved: true, branch }
  }
  if (input.localBranches.includes('main')) return { resolved: true, branch: 'main' }
  if (input.localBranches.includes('master')) return { resolved: true, branch: 'master' }
  return { resolved: false }
}

/**
 * Extracts the branch name from a `git symbolic-ref refs/remotes/<remote>/HEAD` target (e.g.
 * `refs/remotes/origin/main` -> `main`). Returns null for anything that doesn't match the expected
 * `refs/remotes/<remote>/` prefix for that specific remote, or has nothing after it.
 */
export function extractBranchFromRemoteHeadRef(ref: string, remote: string): string | null {
  const prefix = `refs/remotes/${remote}/`
  if (!ref.startsWith(prefix)) return null
  const branch = ref.slice(prefix.length)
  return branch.length > 0 ? branch : null
}

// ---- repository-root comparison (R-6, Windows path normalization) ----

/** Normalizes a repo-root path for equality comparison: converts backslashes to forward slashes,
 * lowercases it (Windows paths are case-insensitive and can arrive with either separator -- `git
 * rev-parse --show-toplevel` always uses forward slashes, while a pane's stored `defaultCwd` may use
 * backslashes), and drops a trailing separator. Both inputs are always already-absolute paths in
 * practice (see this file's header comment for why this doesn't need `path.resolve`'s `..`/`.` handling). */
export function normalizeRepoRootForComparison(root: string): string {
  const normalized = root.trim().replace(/\\/g, '/').toLowerCase()
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

/** R-6: whether two paths refer to the same repository root, ignoring separator style and case. */
export function areSameRepoRoot(a: string, b: string): boolean {
  return normalizeRepoRootForComparison(a) === normalizeRepoRootForComparison(b)
}

// ---- the sync decision itself ----

export type RepoSyncPlan =
  | { action: 'block-dirty' }
  | {
      action: 'block-busy'
      /** FIX B2/M6 (review iter2): whether a branch switch would actually have been attempted had this
       * pane not been busy -- gates modal vs notification-row-only in main/git/repoSync.ts. See
       * shared/ipc.ts's RepoSyncOutcome.blocked-busy doc comment for the full rationale. */
      requiresSwitch: boolean
    }
  | { action: 'checkout-and-pull'; targetBranch: string }
  | { action: 'pull-only'; targetBranch: string }
  | { action: 'switch-only'; targetBranch: string }
  | { action: 'skip'; reason: string }

export interface PlanRepoSyncInput {
  hasTrackedChanges: boolean
  hasUntracked: boolean
  /** Panes (other than the one launching) whose cwd is inside this same repository and currently have
   * claude running (D-7). Blocks unconditionally when non-empty (reverted in review iter2 -- see this
   * file's planRepoSync doc comment) -- only its emptiness matters for the block/no-block decision; the
   * indices themselves are for the caller's own outcome/alert construction. */
  busyPanes: readonly PaneIndex[]
  /** null = detached HEAD (or otherwise indeterminate) -- treated as "not on the default branch". */
  currentBranch: string | null
  defaultBranch: DefaultBranchResolution
  hasRemote: boolean
}

/**
 * The single place U-1's untracked-inclusion policy is applied (plan.md §7): decides, from already-
 * gathered real facts, exactly one of six actions. Never itself talks to git or a dialog --
 * main/git/repoSync.ts executes whichever action comes back, and (FIX B1, review iter1) must call this
 * exactly once with the actual gathered facts -- never with fabricated always-clean/never-busy inputs and a
 * duplicate inline dirty/busy check of its own, which had made this function's block-dirty/block-busy
 * branches unreachable in practice and inverted the required precedence (busy was being checked before
 * status was ever read, so "dirty AND another pane busy" silently showed the busy alert instead of the
 * commit-prompt one the requirement names).
 *
 * Precedence: an unclean worktree blocks unconditionally, before anything else is even considered (D-4/R-3
 * is the requirement's own namesake, verbatim: "未commitのファイルが残っていれば...ブランチは移動しない").
 * The busy-neighbor-pane check (D-7) blocks unconditionally too, right after dirty -- **reverted in review
 * iter2** to the plan-approved rule: iter1's FIX M6 relaxed this so an in-place `pull` (no `checkout`) could
 * proceed even with a busy neighbor pane, but `pull --ff-only` still rewrites tracked files and advances
 * HEAD in that neighbor's working tree out from under its running claude -- exactly the event D-7 exists to
 * prevent, not merely a `checkout`-specific one. `requiresSwitch` is still computed and returned (from the
 * facts already gathered) so main/git/repoSync.ts can keep iter1's *other*, still-valid usability fix: only
 * interrupt with a modal when a `checkout` would actually have run; a busy-block that would only have been a
 * `pull` gets a notification row instead.
 */
export function planRepoSync(input: PlanRepoSyncInput): RepoSyncPlan {
  if (input.hasTrackedChanges || input.hasUntracked) return { action: 'block-dirty' }

  if (input.busyPanes.length > 0) {
    const requiresSwitch = !(
      input.defaultBranch.resolved &&
      input.currentBranch !== null &&
      input.currentBranch === input.defaultBranch.branch
    )
    return { action: 'block-busy', requiresSwitch }
  }

  if (!input.defaultBranch.resolved) {
    return { action: 'skip', reason: 'デフォルトブランチを判定できませんでした' }
  }

  const target = input.defaultBranch.branch
  const onDefaultBranch = input.currentBranch !== null && input.currentBranch === target

  if (onDefaultBranch) {
    if (!input.hasRemote) {
      return {
        action: 'skip',
        reason: `既に既定ブランチ (${target}) です（remote が未設定のため pull もありません）`
      }
    }
    return { action: 'pull-only', targetBranch: target }
  }

  if (!input.hasRemote) return { action: 'switch-only', targetBranch: target }
  return { action: 'checkout-and-pull', targetBranch: target }
}

// ---- user-facing text (D-9: notification row / alert dialog body, both main and renderer) ----

/** R-8: renders every `RepoSyncOutcome` kind to a Japanese sentence -- no kind is left console-only. */
export function describeRepoSyncOutcome(outcome: RepoSyncOutcome): string {
  switch (outcome.kind) {
    case 'not-a-repo':
      return 'このフォルダは git リポジトリではないため、ブランチ同期をスキップしました'
    case 'git-unavailable':
      return `git を実行できないため、ブランチ同期をスキップしました（${outcome.message}）`
    case 'blocked-dirty': {
      const shown = outcome.samplePaths
      const omitted = outcome.changedCount - shown.length
      const lines = shown.map((p) => `  - ${p}`).join('\n')
      const omittedLine = omitted > 0 ? `\n  ...他 ${omitted} 件` : ''
      // FIX C (review iter2): the branch-continuation note leads the sentence, ahead of the repo path, so
      // Pane.tsx's single-line-truncated view (FIX M8) keeps the most important fact -- which branch this
      // session is about to start on -- visible even when repoRoot is long.
      const branchNote =
        outcome.currentBranch !== null
          ? `現在のブランチ (${outcome.currentBranch}) のまま開始します。`
          : '現在の状態のまま開始します。'
      // FIX B1 (review iter2): restores the requirement's own literal "commit を促す" wording, which
      // iter1's FIX M5 dropped entirely while fixing a real self-contradiction (a session always starts
      // regardless, D-2/R-9, so the old "commit してから新規セッションを開始してください" wrongly implied
      // committing was a precondition for starting) -- this both prompts a commit *and* states plainly
      // that this session proceeds anyway.
      return (
        `${branchNote}${outcome.repoRoot} に未コミットの変更が ${outcome.changedCount} 件あります。` +
        'commit してから改めて新規セッションを開始すると、デフォルトブランチへの移動と pull が行われます。' +
        `\n${lines}${omittedLine}`
      )
    }
    case 'blocked-busy': {
      const panes = outcome.busyPanes.map((p) => `ペイン${p + 1}`).join('、')
      // FIX M2 (review iter2): distinguishes "a neighbor pane's claude is actually running" (cause:
      // 'running') from "a neighbor pane's own git sync is still in flight, claude hasn't started yet"
      // (cause: 'launching') -- the previous single wording claimed claude was running even for the
      // latter, which is not true and gave no useful next step.
      if (outcome.cause === 'launching') {
        return `${outcome.repoRoot} は${panes}で git 同期を実行中です。完了後にもう一度お試しください`
      }
      return `${outcome.repoRoot} は${panes}で claude が実行中のため、ブランチ同期をスキップしました`
    }
    case 'skipped':
      return `ブランチ同期をスキップしました: ${outcome.reason}`
    case 'synced': {
      const branchPart = outcome.switched
        ? `${outcome.fromBranch ?? '(不明)'} から ${outcome.branch} へ切り替えました`
        : `${outcome.branch} のままです`
      // FIX M1 (review iter2): branches on the actual reason instead of a single hardcoded "remote が未設定
      // のため" -- a branch switch can legitimately happen while pull is skipped for either reason (remote
      // not configured, or upstream not configured), and this text must never claim "スキップしました" for
      // a pull step while separately implying nothing else happened when a checkout in fact did.
      const pullPart = outcome.pulled
        ? '最新を取り込みました'
        : `pull はスキップしました（${outcome.pullSkippedReason ?? '理由不明'}）`
      return `${branchPart}。${pullPart}`
    }
    case 'failed': {
      // FIX M9 (review iter1): a Japanese step-specific lead sentence + suggested next action precedes the
      // raw (often English, e.g. gitCli.ts's timeout message) detail, instead of showing only the raw
      // detail after a timed-out wait of up to 30s with no explanation of what to do about it.
      const stepLabels: Record<'status' | 'checkout' | 'pull', string> = {
        status: '状態の確認',
        checkout: 'ブランチの切り替え',
        pull: '最新の取り込み（pull）'
      }
      const nextActions: Record<'status' | 'checkout' | 'pull', string> = {
        status: 'ターミナルで `git status` を実行し、原因を確認してください。',
        checkout: '作業ツリーの状態を確認のうえ、ターミナルで `git checkout` を試してください。',
        pull: 'コンフリクトや認証設定を確認のうえ、ターミナルで `git pull` を試してください。'
      }
      const stepLabel = stepLabels[outcome.step]
      const nextAction = nextActions[outcome.step]
      return (
        `git 同期（${stepLabel}）に失敗しました（${outcome.repoRoot}）。${nextAction}\n` +
        `詳細: ${outcome.message}`
      )
    }
  }
}
