# M14 受け入れ基準 — 停止時クリーンナップ / 評価への異議申し立て

出典は `milestones/M14-stop-cleanup-and-appeal/plan.md`（R-1〜R-7）と
`docs/adr/0016-stop-cleanup-and-evaluation-appeal.md`（D-1〜D-5）。
共通ゲート: `tsc --noEmit`（node/web/e2e）/ `eslint` / `vitest run` が green。

## R-1: 完了後の停止でクリーンナップ

- [ ] `src/renderer/src/components/Pane.tsx` の「停止」が、`purpose.status === 'completed'` のときだけ
      端末クリア＋情報行リセットを行う
- [ ] リセット対象: session telemetry 行 / git 同期通知 / エラー行（pty・フォルダ・目的・起動）/
      アーカイブ警告
- [ ] ヘッダの「完了済み」バッジと「評価を見る」ボタンは残る

## R-2: 進行中の目的では消さない

- [ ] `purpose.status === 'active'` での停止では `cleanup()` が呼ばれない（再開オーバーレイの下に
      前回の端末内容が残る）

## R-3: 停止後の残り物

- [ ] クリーンナップ後に届いた `pty:data` が端末へ書かれない
- [ ] `[claude exited: code=N]` がクリーンナップ後の画面に出ない
- [ ] 次の「＋ 新規セッション」/「再開」で抑止が解除され、通常どおり出力・exit 通知が出る

## R-4: 端末をリサイズしない

- [ ] `cleanup` 経路から `pty.resize` / `fitAddon.fit()` を呼ばない（grep で確認可能）

## R-5〜R-7: 異議申し立てと再評価

- [ ] `EvaluationDialog` に異議文の入力欄と「異議を申し立てて再評価」ボタンがあり、空・空白のみでは
      送信できない（`disabled`）
- [ ] `EvaluationRerunRequest.appealText` が preload → `handlers.ts` → `EvaluationCoordinator.rerun` へ
      通り、空白のみ・過大長は main 側でも弾く/切り詰める
- [ ] `buildEvaluationPrompt` が異議文と直前評価（スコア・総評）を含め、「無条件に迎合しない」指示を
      出す（`src/shared/evaluation.test.ts` の unit テスト）
- [ ] 異議つき再評価が新しい `evaluations` 行を作り、`appeal_text` に保存される。既存行は変わらない
- [ ] `evaluations` に `appeal_text` が無い既存 DB でも起動時 migration で列が追加される
      （`src/main/db/schema.test.ts`）
- [ ] ダイアログが「異議申し立てを踏まえた再評価」であることと異議文を表示する
- [ ] 評価レポート（Markdown / JSON）に異議文が出力される
