# M11 残課題（followups）

ビルドループ終了時（2026-07-28、反復3で4体 PASS）に残った non_blocking。
次回 `/cockpit-plan` が起案時に参照する。すべて blocking ではない（合格を妨げない）。severity 順。

## major（挙動が仕様の意図とわずかにずれる）

- **[major] デフォルトブランチが解決できない場合も `requiresSwitch: true` になる** —
  `src/shared/gitSync.ts:189`（テスト `gitSync.test.ts:190` が「解決済みターゲットなしでは判定できない」として固定）。
  デフォルトブランチが解決不能なら busy でない経路は `skip` を返す＝ checkout は最初から起きないので、
  この事実は「判定不能」ではなく「switch は起きない」と確定できる。結果、**cockpit が何もしなかったはずの
  ケースで modal が出る**（ADR-0013 D-7/D-9 の「modal はブランチ移動が実際に必要だった場合のみ」に反する）。
  `cause:'launching'` 側の保守的 `true` は先行 launch の事実が未収集なので正当だが、こちらは事実が手元にある。
  architect 指摘。修正案:
  `requiresSwitch = input.defaultBranch.resolved && input.currentBranch !== input.defaultBranch.branch`
  とし、テスト名と期待値を更新する。

## minor（正確性・堅牢性）

- **[minor] `ENOENT` が「git が見つからない」と「cwd が存在しない」を区別しない** — `src/main/git/gitCli.ts:83-86`。
  code レビュアーが実測: 存在しないディレクトリを cwd に渡すと `code=ENOENT / spawn git ENOENT` となり、
  一律 `kind:'enoent'` に写像される。設定済みフォルダが削除・リネームされたペインで新規セッションを始めると
  「git を実行できないため…」と表示され、実際の原因（フォルダが無い）が伝わらない。busy 候補側では
  安全側に倒れて `repoSync.ts:342-355` の永続ブロックにもなりうる。
  修正案: cwd の存在を先に確認して別理由として扱うか、ENOENT を cwd 由来と実行ファイル由来で切り分ける。

- **[minor] 陳腐化したコメントが差し戻し前の規則を主張している** — `src/main/git/repoSync.ts:147-150`。
  `runLockedSync` 冒頭が "dirty blocks unconditionally; busy only blocks when a switch is actually needed, FIX M6"
  のままで、反復3 で戻した実挙動（busy も無条件ブロック、`requiresSwitch` は modal の強さのみ）と逆の説明。
  `planRepoSync` 側（`gitSync.ts:174-183`）は正しく書き直されている。code / architect / requirements の3体が指摘。

- **[minor] `src/shared/ipc.ts:226-227` のヘッダコメントが現行規則と不一致** —
  「`blocked-dirty`/`blocked-busy` via a native alert (D-9), the rest via a pane-local notification row」だが、
  `blocked-busy` は `requiresSwitch=false` なら modal 無し。requiresSwitch の但し書きを追記する。

- **[minor] `synced` / `blocked-busy` の不正状態が型で排除されていない** — `src/shared/ipc.ts:228`。
  `pulled: boolean` と `pullSkippedReason: string|null` が独立フィールドで、doc コメントの
  「`pulled` が false のときちょうど non-null」を型が保証しない（症状として `gitSync.ts:271-273` に
  到達しないはずの `?? '理由不明'` フォールバックが生えている）。`cause:'launching' ⇒ requiresSwitch:true`
  も同様にコメント止まり。同ファイルが `switched`/`fromBranch` で既に使っている書き分けに揃える:
  `{pulled:true; pullSkippedReason:null} | {pulled:false; pullSkippedReason:string}`、
  `{cause:'launching'} | {cause:'running'; requiresSwitch:boolean}`。code / architect が指摘。

- **[minor] ADR-0013 D-6 が3層構成で現在の規則が読み取りにくい** — `docs/adr/0013-git-sync-on-session-launch.md:65`。
  基底文 ＋「改定（iter1, M4）」＋「訂正（iter2, M1）」が積まれており、基底文と矛盾はしないが3層を読まないと
  確定した規則が分からない。D-7 で採った書式（基底文を現在の規則に統一し、経緯は「却下した代替案」に落とす）に
  揃える。**ただし 0013 が commit された後は `docs/adr/README.md:3` の原則どおり新 ADR で supersede すること**。

## minor（構造）

- **[minor] `repoSyncLock` の2段プロトコルが呼び出し側の規律に依存** — `src/main/git/repoSyncLock.ts:20`。
  `holderPane` + `withLock` の間に await を挟まないことをコメントで約束しているだけ。
  修正案: `tryWithLock(root, pane, fn): Promise<T | { busyHolder: PaneIndex }>` の1関数にまとめ、
  アトミック性を構造で保証する。architect（反復2 から継続）。

- **[minor] `PaneLaunchStartResult` の判別子が `pid: number | null`** — `src/shared/ipc.ts:211`。
  narrowing は効くが、明示タグ（`ok` / `kind`）の方が第3の分岐が増えたときに壊れにくい。architect（反復2 から継続）。

- **[minor] `RepoSyncOutcome` の定義場所が ipc.ts 自身の慣行と逆** — `src/shared/ipc.ts:228`。
  `ipc.ts:258-262` が明文化した慣行（値型は純モジュールで定義し ipc.ts が re-export、先例 `shared/usage.ts`）と逆に、
  `RepoSyncOutcome` を ipc.ts で定義し純モジュールが逆輸入している。定義を `shared/gitSync.ts` へ移して
  re-export するか、慣行側に例外理由を明記する。architect（反復1 から継続）。

- **[minor] `PurposeCoordinator` の deps が16個規模** — `src/main/pty/purposeCoordinator.ts:21`。
  god-object 化しつつある（`prepareRepo` の追加自体は ADR-0013 D-3 どおりで妥当）。
  `purposeStore` / `sessionSync` / `launchEnv` 等の凝集単位でグルーピングを検討。architect（反復1 から継続）。

## minor（UX の磨き込み）

- **[minor] `blocked-dirty` の通知行1行目で行動可能な部分が切れる** — `src/shared/gitSync.ts:226-247`。
  1行省略表示では「commit してから改めて新規セッションを開始すると…」が split4 で切れる。
  修正案: 通知行の1行目を短縮形（例「未コミット 3 件のため現在のブランチ (X) のまま開始します（commit 後に再実行で同期）」）に
  し、詳細展開に全文を置く。usability。

- **[minor] ライブリージョンが内容と同時にマウントされ読み上げされない可能性** —
  `src/renderer/src/components/Pane.tsx:280-313`（`.pane-error`/`.pane-warning` からの既存パターン）。
  空のライブリージョンを常設して内容だけ差し替える。

- **[minor] `not-a-repo` の通知行が閉じるまで残り続ける** — `src/shared/gitSync.ts:222-223`。
  git 管理外フォルダでは毎回出る恒久ノイズ。情報系の kind は一定時間で自動消去する。

- **[minor] 唯一作業ツリーが変わった `synced(switched)` が `not-a-repo` と同じ視覚重み** —
  `src/shared/gitSync.ts:260-270`。切替時のみ accent 系スタイルにする。

- **[minor] 準備中表示が静的1行で経過もフェーズも出ない** — `src/renderer/src/components/Pane.tsx:232-236`。
  実際の最悪待ち時間は照会＋checkout＋pull の合計（spec §7 は出荷時に「30 秒を超えうる」へ訂正済み）。
  経過秒/フェーズ表示を検討。

- **[minor] 準備中も「フォルダ選択」が有効** — `src/renderer/src/components/Pane.tsx:205-207`。
  起動中の cwd を差し替えられる。`launchKind !== null` の間は無効化する。

- **[minor] 行高一致が `min-height`（下限）依存** — `src/renderer/src/styles.css`。
  将来ボタンのフォント/padding が変われば `.pane-launch-status` と `.pane-repo-sync` の行高差が復活し、
  端末行数が動く。height 固定かボタン側の line-height 固定で担保する。

## minor（テスト）

- **[minor] busy 経路・in-flight ロックの E2E 回帰が無い** — `e2e/git-sync.spec.ts`。
  `blocked-busy` の modal 出し分けと `cause:'launching'` は unit テストのみ。多ペインで同一リポジトリを
  使う構成は実運用で踏みやすい。E2E 1本の追加価値あり（acceptance の要求外）。requirements（反復2 から継続）。

- **[minor] `cwds.delete` の respawn 耐性がテストで固定されていない** — `src/main/pty/ptyManager.test.ts:162-174`。
  「respawn 後に旧インスタンスの exit が遅れて届く」ケースは `isRunning`/`write` では固定されているが、
  `getRunningCwd` は assert されていない（コード上はインスタンス同一性ガード内なので安全であることは確認済み）。
  `expect(manager.getRunningCwd(0)).toBe('C:\\repo-new')` 相当を1行足す。

- **[minor] `changedCount` が実ファイル数より少なくなりうる** — `src/main/git/repoSync.ts:215-216`。
  `--untracked-files=normal` は未追跡ディレクトリを1エントリに畳むため。文言を「N 箇所」にする。
  code（反復1 から継続）。

- **[minor] `repoSync.test.ts` が Windows 前提** — 期待値が `C:\repo` と `path.resolve` の Windows 挙動に依存し、
  Windows 以外では成立しない（本プロジェクトは Windows 固定なので実害なし）。冒頭に前提を明記する。
  code（反復1 から継続）。
