---
milestone: M11
title: 新規セッション開始時の git 同期（デフォルトブランチ移動と pull、未コミット時はアラート）
status: shipped   # draft → approved（/cockpit-build 起動 = 承認イベント）→ shipped（品質ゲート合格）
created: 2026-07-28
decisions: docs/adr/0013-git-sync-on-session-launch.md
---

# M11 — 新規セッション開始時の git 同期

## 1. 背景・要望

> 新規セッションを開始した時、選択されているフォルダがgitリポジトリと紐づいていれば、
> 当リポジトリのデフォルトブランチに移動して最新をpullさせるようにする。
> ただし、未commitのファイルが残っていれば、commitを促すアラートダイアログを表示させ、ブランチは移動しない

（2026-07-28 セッションでのユーザー発言・原文）

現状、cockpit は「＋ 新規セッション」でペインの `defaultCwd` をそのまま `cwd` として claude を
spawn するだけで（`src/main/pty/purposeCoordinator.ts:91`）、その作業ツリーがどのブランチの・
いつ時点の状態かには関知しない。結果として、前回作業のフィーチャーブランチに居たまま、
あるいは remote から数十コミット遅れたまま新しい目的のセッションが始まりうる。

本マイルストーンは、**新規セッション開始を「作業ツリーを既知の起点に揃える」タイミングとして扱う**。
ただし cockpit の副作用が及ぶ範囲はユーザーの作業ツリーという app 外部の資産なので、
踏み込む操作は `checkout` と `pull --ff-only` の2つに限り、未コミットの変更がある場合は何もしない。

### 現状の起動経路（実装の確認結果）

| 経路 | 入口 | 本 M の対象 |
|---|---|---|
| 「＋ 新規セッション」ダイアログ確定 | `IpcChannels.paneLaunchStart` → `PurposeCoordinator.startNewSession` | **対象** |
| 「再開」（TD-7、`--continue`） | `IpcChannels.paneLaunchResume` → `PurposeCoordinator.resumeSession` | 対象外（ADR-0013 D-1） |
| ペイン内の `/clear` `/resume` | pty 素通し。アプリに介入経路が無い | 対象外（同上） |

ネイティブダイアログの前例は `paneSettingsConfirmActivePurposeCwdChange`
（`src/main/ipc/handlers.ts:288-303`、`dialog.showMessageBox`）にある。E2E からは
`app.evaluate(({ dialog }) => { dialog.showMessageBox = ... })` でスタブできる
（`e2e/app.spec.ts:126` の `showOpenDialog` スタブと同型）。

## 2. 要件

- **R-1（適用範囲）**: git 同期を試みるのは「＋ 新規セッション」ダイアログ確定による起動
  （`paneLaunchStart`）のときだけ。「再開」（`--continue`）とペイン内のセッション切替では行わない。
- **R-2（リポジトリ判定）**: 起動対象の cwd が git ワークツリー内にあるかを判定する。サブディレクトリで
  あっても所属リポジトリのルートを解決して対象とする。リポジトリでない場合・git が使えない場合は
  何も行わず通常どおり起動する（通知は出すが modal は出さない）。
- **R-3（未コミット時のブロック）**: 未コミットの変更が残っている場合、**commit を促すアラート
  ダイアログを表示し、ブランチ移動も pull も行わない**。ダイアログには対象リポジトリのパスと
  未コミットの件数・先頭数件のパスを載せる。閉じたあとセッションは通常どおり起動する。
- **R-4（デフォルトブランチへの移動）**: 作業ツリーがクリーンなら、リポジトリのデフォルトブランチへ
  `checkout` する。既にデフォルトブランチに居る場合は checkout を行わない（pull のみ）。
  デフォルトブランチを確定できない場合は checkout せずスキップし、理由を可視化する。
- **R-5（最新の取り込み）**: checkout 後（またはデフォルトブランチに既に居る場合はそのまま）
  `git pull --ff-only` を実行する。remote 未設定のリポジトリでは pull をスキップする
  （ブランチ移動は行う）。
- **R-6（他ペインとの競合回避）**: 同一リポジトリを cwd とするペインで claude が実行中の場合は、
  ブランチ移動も pull も行わずアラートで知らせる（ADR-0013 D-7）。
  ※ 通知手段は §7 U-2 で確定（ブロック自体は無条件。modal はブランチ移動が必要だった場合のみ）。
- **R-7（非対話・応答性）**: git が認証プロンプト等でブロックしないよう非対話環境で実行し、
  コマンドごとにタイムアウトを課す。git 実行中はペイン UI に準備中であることを示し、
  「新規セッションボタンが無反応」に見える状態を作らない。
- **R-8（silent failure 禁止）**: 実行した／しなかった結果は常に可視化する。
  ブロック系（R-3 / R-6）は modal、それ以外（成功・スキップ・失敗）はペイン内の通知行
  （ADR-0013 D-9）。失敗を console だけに落とさない。
  ※ R-6 のブロックだけは modal と通知行を出し分ける（§7 U-2 で確定）。modal を出しうるのは
  ブロック系のみ、という排他条件は変わらない。
- **R-9（起動を止めない）**: git がどう転んでもセッションは起動する（ADR-0013 D-2）。
- **R-10（既存の不変条件を壊さない）**: アーカイブの append-only、元 JSONL 非改変、pty 素通し、
  プロセス境界（renderer から git を叩かない）を維持する。作業ツリーへの副作用は
  `checkout` と `pull --ff-only` のみで、`stash` / `reset` / `clean` / `commit` / `rebase` は行わない。

## 3. 設計判断の要旨（本文は ADR-0013）

- **D-1**: 対象は `paneLaunchStart` のみ。`--continue` の前提であるブランチを動かさない
- **D-2**: git 同期は起動の前提条件ではない。失敗・ブロックでもセッションは開始する
- **D-3**: 判定は `src/shared/gitSync.ts`（純関数・test-first）、実行は `src/main/git/gitCli.ts`、
  束ねは `src/main/git/repoSync.ts`。呼び出しは `PurposeCoordinator.startNewSession`
  （「新規セッション確定時に何が起きるか」を決める既存の唯一の場所）
- **D-4**: 未コミット判定は `git status --porcelain` のエントリの有無（untracked を含む・ignore は除く）
  — 2026-07-28 ユーザー確定（§7 U-1 = 案A）
- **D-5**: デフォルトブランチは `refs/remotes/<remote>/HEAD` → ローカル `main` → ローカル `master` の順に
  ローカル情報だけで解決。ネットワーク往復（`git remote show`）はしない
- **D-6**: pull は `--ff-only`。マージコミットも rebase も無断で作らない
- **D-7**: 同一リポジトリで claude 実行中の他ペインがあれば移動しない（§7 U-2 で通知手段を確定）
- **D-8**: `GIT_TERMINAL_PROMPT=0` 等で非対話化＋コマンド別タイムアウト（照会 5s / checkout 20s / pull 30s）
- **D-9**: ブロック系は `dialog.showMessageBox`、それ以外はペイン内通知行
- **D-10**: オン/オフ設定は設けない

### 契約（IPC）

`PaneLaunchStartResult` に同期結果を追加する。renderer は表示のみを行い、判断はしない。

```ts
export type RepoSyncOutcome =
  | { kind: 'not-a-repo' }
  | { kind: 'git-unavailable'; message: string }
  | { kind: 'blocked-dirty'; repoRoot: string; changedCount: number; samplePaths: string[] }
  | { kind: 'blocked-busy'; repoRoot: string; busyPanes: PaneIndex[] }
  | { kind: 'skipped'; reason: string }            // デフォルトブランチ未確定 / remote 無しで pull 不要 等
  | { kind: 'synced'; repoRoot: string; branch: string; switched: boolean; pulled: boolean }
  | { kind: 'failed'; repoRoot: string; step: 'status' | 'checkout' | 'pull'; message: string }

export interface PaneLaunchStartResult {
  pid: number
  purposeId: string
  repoSync: RepoSyncOutcome   // 追加
}
```

## 4. 実装フェーズ

1. **`shared/gitSync.ts`（純関数・test-first）** — CLAUDE.md の「`shared/` は test-first」に従い、
   red を確認してから green にする。
   - `parsePorcelainStatus(stdout: string): WorktreeStatus` — `--porcelain=v1 -z` の NUL 区切り出力を
     `{ entries: {code, path}[], hasTrackedChanges, hasUntracked }` に。rename（`R  old\0new`）の
     2 パス消費、`?? ` の untracked 判定、空出力 = クリーン、未知コードは「変更あり」側に倒す（寛容）
   - `resolveDefaultBranch(input: { remoteHeads, localBranches, remotes }): DefaultBranchResolution` —
     D-5 の解決順。解決不能を明示的な値で返す（例外にしない）
   - `planRepoSync(input): RepoSyncPlan` — `{ hasTrackedChanges, hasUntracked, busyPanes, currentBranch,
     defaultBranch, hasRemote }` から `block-dirty | block-busy | checkout-and-pull | pull-only |
     switch-only | skip` を決定的に返す。**未決（§7）の切替点はこの関数の1箇所に閉じる**
   - `describeRepoSyncOutcome(outcome): string` — 通知行・ダイアログ本文の日本語文言（main/renderer 共用）
2. **`main/git/`（副作用層）** —
   - `gitCli.ts`: `execFile('git', args, { cwd, timeout, env })` の唯一の窓口。非対話 env（D-8）、
     コマンド別タイムアウト、`{ ok: true, stdout } | { ok: false, message }` の Result 型。
     `git` が見つからない（ENOENT）を専用の値で返す
   - `repoSync.ts`: `prepareRepoForLaunch(cwd, deps): Promise<RepoSyncOutcome>`。
     リポジトリルート解決 → 稼働中ペインの照会（注入された port）→ status → プラン決定（純関数）→
     checkout / pull → アラート表示（注入された port）。gitCli と dialog を fake にした unit テストで
     全分岐を固定
3. **配線（main）** — `PurposeCoordinator` に `prepareRepo` dep を追加し、`startNewSession` を async 化して
   **spawn の前に** await する。既存の順序不変条件（spawn 失敗時に purpose 行を残さない）は維持。
   `handlers.ts` の `paneLaunchStart` は async 化して結果を返すだけ（順序ロジックを持たせない）。
   稼働中ペイン判定は `PtyManager.isRunning` ＋ `paneSettingsRepo` の cwd を注入して解決
4. **renderer** — `Pane.tsx` に git 準備中の表示（起動ボタン押下後〜結果到着まで）と、
   結果の通知行（`kind` により `role="alert"` / `role="status"` を出し分け）。`usePtyPane` の
   `start()` が返す結果を受け取れるようにする（現状は戻り値を捨てている）
5. **E2E**（`e2e/git-sync.spec.ts` 新規） — 一時ディレクトリに `git init` した fixture リポジトリを作り、
   fake-claude で起動する:
   - clean ケース: feature ブランチに居る状態から起動 → デフォルトブランチへ移動していること
   - dirty ケース: 未コミットファイルを置いて起動 → `dialog.showMessageBox` がスタブで呼ばれ、
     ブランチが移動していないこと、かつセッションは起動していること

## 5. リスク

- **外部資産への副作用** — 本 M で初めて cockpit がユーザーの作業ツリーを書き換える。`checkout` は
  未コミットがあれば git 自身が拒否するが、cockpit 側でも事前に status で止める（二重の歯止め）。
  それでも「気づかないうちにブランチが変わっている」体験は起こりうるので、通知行の文言で
  移動元→移動先を明示する
- **起動レイテンシ** — pull はネットワーク次第で数秒〜タイムアウト（30s）まで伸びる。新規セッションの
  体感が悪化する。D-8 のタイムアウトと準備中表示で緩和するが、遅い回線では体感差が残る
- **認証プロンプトによる無限待ち** — 非対話 env を渡し忘れると git がクレデンシャル入力を待って
  固まる（Windows の Git Credential Manager は GUI を出しうる）。D-8 は必須要件であり、
  acceptance で env を明示的に検証する
- **Windows のパス比較** — R-6 の同一リポジトリ判定は `rev-parse --show-toplevel` の出力
  （スラッシュ区切り）と `defaultCwd`（バックスラッシュ）を比較する。正規化を誤ると
  ガードが効かない／過剰に効く。純関数側に寄せてテストで固定する
- **worktree / submodule / detached HEAD** — いずれも「デフォルトブランチが確定できない」または
  「未コミットあり」に落ちてスキップ・ブロックする。無理に対応しない（スコープ外）

## 6. スコープ外

- `stash` / `reset` / `clean` / `commit` / `push` / `rebase` / merge 競合の解消
- git 同期のオン/オフ設定 UI、リポジトリごとの対象ブランチ設定（ADR-0013 D-10）
- 「再開」（`--continue`）およびペイン内 `/clear` `/resume` での git 同期（D-1）
- 認証情報の管理・ネットワークプロキシ設定
- submodule の再帰更新、git worktree 固有の扱い
- 過去に開始したセッションへの遡及（本 M 以降の新規セッションにのみ効く）

## 7. 確定した論点（起案時の未決）

- **U-1: 未コミット判定に untracked（未追跡ファイル）を含めるか → 2026-07-28 ユーザー確定: 含める（案A）**
  - `git status --porcelain` にエントリが1つでもあれば（untracked のみでも）ブロックする。
    ignore 済みは対象外（`--ignored` を付けない）。要件の「未commitのファイル」の文字どおりの読みであり、
    「commit を促す」という目的（新規追加ファイルこそ commit 漏れしやすい）に合う
  - 受容する代償: `.gitignore` に載っていない一時ファイルが1つあるだけでアラートが出て
    ブランチ移動が行われない
  - 却下した案B（tracked の変更のみをブロック対象とし untracked は通す）は、アラート頻度は下がるが
    ユーザーの明示要件から離れるため採らない
  - 実装上は `planRepoSync` の入力を `{ hasTrackedChanges, hasUntracked }` に分けたまま保ち、
    判定を1箇所に閉じる（将来の方針変更が純関数1本の差で済む形は維持する）

- **U-2: 他ペイン稼働中（R-6）のブロックの強さ → 2026-07-28 ビルドループ反復2 で確定**
  - **ブロック自体は無条件**（起案時の R-6 のまま）。同一リポジトリで claude 実行中なら
    checkout も `pull --ff-only` も行わない。`pull --ff-only` も稼働中エージェントの作業ツリーの
    tracked ファイルを書き換え HEAD を進めるため、checkout だけを特別扱いしない
    （code / requirements レビュアー指摘）
  - **通知手段だけを出し分ける**: ブランチ移動が実際に必要だった場合は `dialog.showMessageBox`、
    移動不要（既にデフォルトブランチかつクリーン）だった場合はペイン内の通知行のみ。
    同一リポジトリを複数ペインで使う構成での modal 頻発を避けるため（usability レビュアー指摘）
  - 経緯: 反復1 の FIX 指示で「移動不要なら busy でも pull は実行する」と一度緩めたが、
    これは承認済みの本 plan R-6 を無断で緩めるものだったため反復2 で取り下げた。
    却下した代替案として ADR-0013 D-7 に記録済み

## 8. spec 更新（出荷時 = `/cockpit-build` 合格処理の責務）

- **§2 スコープ**: 「含む」に「新規セッション開始時の作業ツリー準備（デフォルトブランチへの移動と
  `pull --ff-only`）」を追記する。責務が1つ増えることを現在形の spec に明示する
- **§4.2 起動フロー**: ステップ1（新規セッション押下）とステップ2（claude 起動）の間に、
  git 同期のステップを追記する。未コミット時・他ペイン使用中はブロックしてアラートを出すこと、
  いずれの場合もセッションは起動することを含める
- **§7 リスク・制約**: 「pull はネットワーク状況により起動を最大 30 秒待たせうる」「非 fast-forward・
  認証失敗などは可視化のみで自動解消しない」を追記する
