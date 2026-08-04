# M11 反復2 — 新規セッション開始時の git 同期

日付: 2026-07-28 / 判定: **FAIL**（4体中3体 PASS、requirements のみ FAIL）

## 静的ゲート（オーケストレータが実測）
`typecheck`（node/web/e2e）exit 0 / `eslint` exit 0 / `vitest run` 648 passed（38 files） /
`playwright test` 8 passed

## verdict サマリ

| reviewer | status | score |
|---|---|---|
| code | PASS | 90 |
| architect | PASS | 91 |
| usability | PASS | 87 |
| requirements | FAIL | 84 |

## 反復1 blocking の解消（全レビュアーがコードで確認）
- B1 判定の重複・優先順位逆転 → `planRepoSync` を実値で1回だけ呼ぶ形に `repoSync.ts` を全面書き換え。
  dirty > busy が実行時テストで固定（`repoSync.test.ts:325`）。到達不能 throw を削除
- B2 git 照会失敗の空値写像 → `branch` / `remote` / `for-each-ref` の `!ok` を `failed(step:'status')` に。
  checkout/pull に進まないことをテスト3件で固定（`repoSync.test.ts:346-403`）
- B3 起動失敗で repoSync が消える → `PaneLaunchStartResult` を判別共用体化し、`pid:null` 経路でも
  `repoSync` を renderer へ届ける
- B4 サブディレクトリ解決のテスト → `repoSync.test.ts:135` で repoRoot 解決と後続コマンドの cwd を固定

## 主な追加実装（反復1 major への対応）
`repoSyncLock.ts`（repoRoot 単位 in-flight ロック）/ `repoSyncDeps.ts`（ポート構築の抽出）/
`PtyManager.getRunningCwd`（実 spawn cwd の追跡）/ `handlers.ts` の pane 単位 in-flight Set /
locale 固定（`LC_ALL=C` 等）/ upstream 未設定時の扱い / 通知行の1行化＋展開＋閉じる /
`launchKind` による準備中文言の出し分け

## blocking（反復2、2件・いずれも requirements）

**B1** `gitSync.ts:214-231`。FIX M5 の副作用で **「commit を促す」文言が完全に消えた**
（src 全体を grep してもコメント内のみ）。ユーザー要件原文・spec §4.2・ADR-0013 D-9・plan R-3・
acceptance R-3 のすべてと食い違う。commit 促しを戻したうえでセッションは開始される旨を併記して両立させる。

**B2** `acceptance.md:73-75` / `plan.md:57-58` と実装（`gitSync.ts:186-196`）の矛盾。
反復1 で指揮者が出した FIX 指示 **M6（既定ブランチ在籍なら busy でも pull を実行）が、ユーザー承認済みの
plan R-6「ブランチ移動も pull も行わずアラートで知らせる」を無断で緩めていた**。
4体すべてがこの不整合を指摘し、code / requirements は「`pull --ff-only` も稼働中エージェントの
作業ツリーの tracked ファイルを書き換え HEAD を進める点で checkout と変わらない」と指摘。
**指揮者判断: M6 を取り下げ、承認済みの R-6（busy なら checkout も pull も行わない）に戻す。**
modal 頻発への対処は「通知の強さの出し分け」（ブランチ移動が必要なときだけ modal、他は通知行）に限定し、
「同期を行わない」点は一貫させる。ADR-0013 D-7 は未コミットなので基底文を書き直して
1決定1規則に戻す（architect 指摘）。

## major（反復3 の FIX 対象に含めた 4 件）
M1 checkout 済みなのに `skipped` を返す自己矛盾表示（requirements ＋ usability） /
M2 `blocked-busy` が running と launching の2原因を兼ね文言が事実と異なる（code ＋ architect ＋ usability） /
M3 busy 候補の rev-parse 失敗が無言で「非該当」に倒れる（code） /
M4 busy 候補側に空 stdout ガードが無く、対象リポジトリ直下から `npm run dev` すると誤 blocked-busy（code）

## 判定
requirements FAIL（score 84）。blocking 2 件 ＋ major 4 件 ＋ 軽微6件を FIX として差し戻し、反復3へ。
