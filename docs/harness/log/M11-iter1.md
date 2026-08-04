# M11 反復1 — 新規セッション開始時の git 同期

日付: 2026-07-28 / 判定: **FAIL**

## 静的ゲート（オーケストレータが実測）
`typecheck`（node/web/e2e）exit 0 / `eslint` exit 0 / `vitest run` 611 passed（37 files） /
`playwright test` 8 passed（新規 `e2e/git-sync.spec.ts` の clean / dirty 2件を含む）

## verdict サマリ

| reviewer | status | score |
|---|---|---|
| code | FAIL | 84 |
| architect | FAIL | 80 |
| usability | FAIL | 62 |
| requirements | FAIL | 84 |

## 変更ファイル
- `src/shared/gitSync.ts` / `gitSync.test.ts`（新規・純関数・test-first、41 tests）
- `src/main/git/gitCli.ts` / `gitCli.test.ts`（新規、8 tests）
- `src/main/git/repoSync.ts` / `repoSync.test.ts`（新規、17 tests）
- `src/shared/ipc.ts`（`RepoSyncOutcome` ＋ `PaneLaunchStartResult.repoSync`）
- `src/main/pty/purposeCoordinator.ts`（`startNewSession` async 化・`prepareRepo` dep）
- `src/main/ipc/handlers.ts` / `src/main/index.ts`（dep 配線）
- `src/renderer/src/hooks/usePtyPane.ts` / `components/Pane.tsx` / `styles.css`
- `e2e/git-sync.spec.ts`（新規）
- `docs/claude-multi-window-spec.md` §2/§4.2/§7、`docs/adr/0013-*.md`（status→accepted）

## blocking（集約後 4 件）

**B1（architect ＋ requirements）** `repoSync.ts:111-136,166,168-175` / `gitSync.ts:157-166`。
`planRepoSync` が常に `hasTrackedChanges:false / hasUntracked:false / busyPanes:[]` で呼ばれ、
dirty/busy の判定が副作用層のインライン条件に重複。ADR-0013 D-3/D-4 と plan §7 の
「判定を純関数1箇所に閉じる」が未成立で、U-1 の方針変更が黙って無効化される構造。
純関数側の block 分岐は到達不能（`unreachable` throw ＋ 空振りテスト）。
さらに busy を status より先に評価するため **「未コミット＋同一リポジトリで他ペイン稼働中」で
commit を促すアラートが出ない** — ユーザー要件原文と spec §4.2 からの逸脱。
指揮者判断: **dirty 優先を実挙動にする**（実装をドキュメントに合わせる。ADR/plan は不変更）。

**B2（code）** `repoSync.ts:146-149`。`branch --show-current` / `remote` / `for-each-ref` の失敗が
`null` / `[]` に写像され、`remote` 照会が失敗しただけで「remote が未設定のため pull はスキップしました」と
事実と異なる説明を出したうえでブランチ移動まで進む。R-8（silent failure 禁止）違反。

**B3（usability）** `Pane.tsx:120` / `usePtyPane.ts:148-150`。spawn/IPC 失敗時に `start()` が null を返し、
**直前に実際にブランチを動かした** `RepoSyncOutcome` が捨てられる。作業ツリーが変わったのに無表示。R-8 違反。

**B4（requirements）** `repoSync.test.ts`。acceptance R-2 が明示要求する「cwd がサブディレクトリでも
ルートが解決される」unit テストが無い。後続 status/checkout/pull が repoRoot で実行されることも未固定。

## major（score >= 85 のゲートのため FIX 対象に含めた 11 件）

M1 locale 依存の stderr 照合（`LC_ALL='C'` 等の欠落、code ＋ architect） /
M2 busy 判定が in-flight を見ず同一リポジトリで checkout 競合（code ＋ architect ＋ usability） /
M3 busy 判定が実 spawn cwd でなく `defaultCwd` 参照（architect） /
M4 upstream 未設定で pull が毎回 failed（code） /
M5 blocked-dirty の文言が「セッションは開始される」実挙動と矛盾（usability） /
M6 blocked-busy modal が主用途で頻発し稼働中 claude への入力を妨げる（usability） /
M7 「再開」でも「git 同期を確認中」と表示（usability） /
M8 通知行が端末ジオメトリを恒久的に動かし CLI 出力を再フロー（usability） /
M9 failed の文言に次アクションが無く timeout は英語内部文言のみ（usability） /
M10 `paneLaunchStart` の isRunning ガードが async 化で TOCTOU 化（requirements） /
M11 E2E dirty ケースが記録の成立を検証していない（requirements）

## 判定
4体すべて FAIL・全 score < 85。blocking 4 件 ＋ major 11 件 ＋ 軽微7件を FIX として差し戻し、反復2へ。
