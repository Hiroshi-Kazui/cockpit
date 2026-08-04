# M11 受け入れ基準 — 新規セッション開始時の git 同期

requirements-reviewer の逐条トレース基準であり、implementer の実装スコープ定義。
各項目は「どのファイル/関数が満たすか」を特定できなければ未達扱い。
共通ゲート: `tsc --noEmit`（node/web）/ `eslint` / `vitest run` / `playwright test` が green。
出典は `milestones/M11-git-sync-on-launch/plan.md`（R-1〜R-10）と `docs/adr/0013-git-sync-on-session-launch.md`（D-1〜D-10）。

> **U-1（plan §7）は 2026-07-28 に確定済み: 未コミット判定に untracked を含める（案A）。**
> `git status --porcelain` にエントリが1つでもあれば（untracked のみでも）ブロックする。
> ignore 済みは対象外。

## R-1: 適用範囲

- [ ] `PurposeCoordinator.startNewSession`（`src/main/pty/purposeCoordinator.ts`）だけが git 同期を
      呼び出す。`resumeSession`（`--continue`）からは呼ばれない（unit テストで、resume 経路では
      `prepareRepo` dep が一度も呼ばれないことを固定）
- [ ] pty 出力・キーストロークを見て `/clear` `/resume` を検知する経路が存在しない
      （spec §4.1 の素通し維持）

## R-2: リポジトリ判定

- [ ] `src/main/git/repoSync.ts` が `git rev-parse --show-toplevel` で cwd の所属リポジトリルートを
      解決する。cwd がリポジトリのサブディレクトリでもルートが解決される（unit テスト: fake gitCli）
- [ ] リポジトリでない cwd では checkout / pull を一切実行せず `{ kind: 'not-a-repo' }` を返す
- [ ] `git` 実行ファイルが見つからない（ENOENT）場合は `{ kind: 'git-unavailable' }` を返し、
      例外を投げない・起動を妨げない
- [ ] どちらのケースでも `dialog.showMessageBox` が呼ばれない（modal を出すのはブロック時だけ）

## R-3: 未コミット時のブロック（要件の中核）

- [ ] `git status --porcelain` の出力にエントリがある場合（**untracked のみでもブロック** — U-1 確定=案A）、
      `git checkout` と `git pull` が**一度も実行されない**
      （unit テスト: fake gitCli に checkout/pull の呼び出しが記録されないことを固定）
- [ ] 同ケースで `dialog.showMessageBox` が commit を促す文言で呼ばれる。本文にリポジトリのパスと
      未コミット件数、先頭数件のパスが含まれる（`src/shared/gitSync.ts` の
      `describeRepoSyncOutcome` が生成し、unit テストで文言を固定）
- [ ] 同ケースでも `spawnPty` が呼ばれセッションが起動する（R-9 と共通。unit テスト）
- [ ] `parsePorcelainStatus`（`src/shared/gitSync.ts`、純関数）に以下の unit テストがある
  - [ ] 空出力 → クリーン
  - [ ] `?? path` のみ → `hasUntracked: true` / `hasTrackedChanges: false`（U-1 確定によりこの状態でも
        `planRepoSync` は `block-dirty` を返す）
  - [ ] ` M path` / `M  path` / `MM path` / `D  path` / `UU path` → `hasTrackedChanges: true`
  - [ ] `R  old\0new` のリネームで NUL 2 パスを正しく消費し、後続エントリがずれない
  - [ ] 未知のステータスコード → 「変更あり」側に倒す（寛容パーサ。情報を失う方向に倒さない）
- [ ] `.gitignore` 済みファイルだけが存在する作業ツリーはクリーン扱い（`--ignored` を付けない）

## R-4: デフォルトブランチへの移動

- [ ] `resolveDefaultBranch`（`src/shared/gitSync.ts`、純関数）が D-5 の順で解決し、各分岐に
      unit テストがある
  - [ ] `refs/remotes/origin/HEAD` が指すブランチを採用
  - [ ] `origin` が無く remote が1つだけ → その remote の HEAD を採用
  - [ ] remote HEAD が無い → ローカル `main` → 無ければローカル `master`
  - [ ] いずれも無い → 解決不能を表す値を返す（例外を投げない）
- [ ] `git remote show` を実行するコード経路が存在しない（ネットワーク往復の禁止。grep で確認可能）
- [ ] 解決不能時は checkout せず `{ kind: 'skipped', reason }` を返す（推測で checkout しない）
- [ ] 既にデフォルトブランチに居る場合 `git checkout` を実行しない（`switched: false` で pull のみ）
- [ ] checkout 失敗（ロック・権限等）は `{ kind: 'failed', step: 'checkout' }` として返り、
      pull は実行されない

## R-5: 最新の取り込み

- [ ] pull コマンドが `git pull --ff-only`（`--rebase` でも引数なしでもない）。
      `src/main/git/repoSync.ts` の呼び出し引数を unit テストで固定
- [ ] remote 未設定のリポジトリでは pull を実行せず、ブランチ移動のみ行い理由を可視化する
- [ ] 非 fast-forward・認証失敗・ネットワーク断は `{ kind: 'failed', step: 'pull' }` として返り、
      git の stderr がメッセージに含まれる（原因が追える）
- [ ] `stash` / `reset` / `clean` / `commit` / `rebase` / `merge` / `push` を実行するコード経路が
      存在しない（`src/main/git/**` の grep で確認）

## R-6: 他ペインとの競合回避

- [ ] 起動対象の cwd が属するリポジトリルートと、claude 実行中の別ペインの cwd が属する
      リポジトリルートが一致する場合、checkout / pull を無条件に実行せず `{ kind: 'blocked-busy', busyPanes }`
      を返す（unit テスト）。通知手段はブランチ移動が必要だった場合のみ `dialog.showMessageBox`、
      不要だった場合（既にデフォルトブランチかつクリーン）はペイン内の通知行のみ（review iter2 確定）
- [ ] リポジトリルートの比較が正規化を経る（Windows: 区切り文字・大文字小文字。純関数として
      `src/shared/gitSync.ts` に置き、`C:/develop/x` と `C:\develop\X` が同一と判定される unit テスト）
- [ ] 実行中ペインの照会が注入された port 経由（`PtyManager` / `paneSettingsRepo` を `repoSync.ts` が
      直接 import しない）

## R-7: 非対話・応答性

- [ ] `src/main/git/gitCli.ts` が渡す env に `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never` が含まれ、
      `GIT_ASKPASS` / `SSH_ASKPASS` が無効化されている（unit テストで env を検証）
- [ ] すべての git 実行に `timeout` が設定される（照会 5s / checkout 20s / pull 30s）。
      タイムアウトが `{ kind: 'failed' }` として返り、例外で落ちない（unit テスト）
- [ ] 「＋ 新規セッション」確定後、git 準備が完了するまでペイン UI に準備中であることが表示される
      （`src/renderer/src/components/Pane.tsx`）。ボタン連打で二重起動できない
- [ ] git を実行するのは main プロセスのみ。preload / renderer に `child_process` や git 実行の
      経路が無い（プロセス境界。grep で確認）

## R-8: silent failure 禁止

- [ ] `RepoSyncOutcome` の全 `kind` が `PaneLaunchStartResult` 経由で renderer に届き、
      ペイン内に表示される（`Pane.tsx`）。console.log のみで終わる分岐が無い
- [ ] modal を出しうるのはブロック系（`blocked-dirty` / `blocked-busy`）だけで、
      `synced` / `skipped` / `failed` / `not-a-repo` / `git-unavailable` は modal を出さない。
      `blocked-dirty` は常に modal、`blocked-busy` は `requiresSwitch=true` の場合のみ modal で
      それ以外は通知行のみ（plan §7 U-2 確定。ブロックすること自体は無条件）
- [ ] 失敗系（`failed`）の通知行が `role="alert"`、それ以外が `role="status"`
- [ ] `describeRepoSyncOutcome` の文言が日本語で、`kind` ごとに unit テストがある
      （移動が起きた場合は移動元→移動先ブランチ名を含む）

## R-9: 起動を止めない

- [ ] `blocked-dirty` / `blocked-busy` / `failed` / `skipped` / `git-unavailable` のいずれでも
      `spawnPty` が呼ばれ、purpose 行が作られ、目的テキストの初回送信・タイトル生成が
      従来どおり動く（`purposeCoordinator.test.ts` に分岐ごとのテスト）
- [ ] git 準備の例外（想定外の throw）が起動を妨げない（catch して `failed` に写像する）
- [ ] spawn 失敗時に purpose 行が残らないという既存の順序不変条件が維持されている
      （git 準備 → spawn → createPurpose の順）

## R-10: 既存の不変条件

- [ ] `src/main/archive/**` に変更が無い（append-only・元 JSONL 非改変に一切触れない）
- [ ] `src/shared/gitSync.ts` が fs / child_process / Electron を import しない（純関数）
- [ ] `nodeIntegration: false` / `contextIsolation: true` は不変。preload の公開 API は
      `paneLaunch.start` の戻り値型が広がるだけで、新規チャネルを増やさない
- [ ] IPC の型定義が `src/shared/ipc.ts` の1箇所に閉じている（`RepoSyncOutcome` の定義が
      main/renderer に重複しない）

## E2E（`e2e/git-sync.spec.ts` 新規）

- [ ] 一時ディレクトリに `git init` した fixture リポジトリを作り、fake-claude で起動する
- [ ] **clean ケース**: デフォルトブランチ以外のブランチに居る clean なリポジトリを cwd にして
      新規セッションを開始 → 起動後に `git rev-parse --abbrev-ref HEAD` がデフォルトブランチを返す
- [ ] **dirty ケース**: 未コミットのファイルを置いて新規セッションを開始 →
      スタブした `dialog.showMessageBox` が呼ばれたことを検証し、ブランチが移動していないこと、
      かつ pty が起動しセッションが記録されていることを検証
- [ ] E2E が実 remote へのネットワークアクセスを必要としない（remote 無しリポジトリ、または
      ローカルの bare リポジトリを remote に使う）

## 既存機能の回帰

- [ ] `purposeCoordinator.test.ts` / `handlers.test.ts` / `ptyManager.test.ts` が green
      （`startNewSession` の async 化に伴う既存テストの追従を含む）
- [ ] 「再開」（TD-7）の一連の挙動が従来どおり（`--continue` 付き spawn、初回プロンプト非送信）
- [ ] 目的が空のまま開始するフロー（spec §4.2）が従来どおり動く
- [ ] 既存 E2E（`e2e/app.spec.ts` / `e2e/archive-output.spec.ts`）が green。
      これらの fixture ディレクトリは git リポジトリではないため `not-a-repo` で素通りする
