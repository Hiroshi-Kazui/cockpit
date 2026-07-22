# M9 受け入れ基準 — 目的完了時の評価（3軸スコア・改善案・週次/月次遷移・出力先設定）

requirements-reviewer の逐条トレース基準であり、implementer の実装スコープ定義。
各項目は「どのファイル/関数が満たすか」を特定できなければ未達扱い。
共通ゲート: `tsc --noEmit`（node/web）/ `eslint` / `vitest run` / `playwright test` が green。
出典は `milestones/M9-purpose-evaluation/plan.md`（R-1〜R-7、D-1〜D-8）。

## R-1: 評価の実行（トリガ・3軸）

- [ ] 目的の「完了」操作成功後に評価が自動起動する（`evaluationCoordinator` が completePurpose 経路から
      呼ばれる配線。`src/main/index.ts`）。完了操作の IPC 応答は評価の完了を待たない（fire-and-forget）
- [ ] 評価入力は、その purpose_id に紐付く全セッション行（`sessionRepo`）と対応するスプールの
      アーカイブ JSONL から構築される。元 JSONL（claude 管理下）・pty には一切アクセスしない
- [ ] 評価結果は順調度 / ストレス度 / コミュニケーションコストの3軸（0–100 整数）＋総評を持つ
      （`evaluations` テーブル。`src/main/db/evaluationRepo.ts`）
- [ ] `evaluation_enabled = false` のとき評価は起動せず、完了操作は従来どおり成功する
- [ ] ヘッドレス実行は `claude -p --model <設定モデル>` で、プロンプトは stdin 渡しのみ。
      argv に目的テキスト・transcript 由来の動的文字列が載らない（`evaluationRunner.ts`、
      titleGenerator と同じ注入不変条件を unit テストで固定）
- [ ] 発言が実質空の目的（セッションなし・ユーザ発言ゼロ）では LLM を呼ばず `skipped` で確定する
      （`buildEvaluationInput` の判定、unit テスト）

## R-2 / R-3: 完了時の表示・改善案

- [ ] 評価完了時、レーダーチャート（3軸スパイダー）・総評・改善案を表示するダイアログが renderer に出る
      （評価ダイアログコンポーネント＋push イベント購読）
- [ ] レーダーの3軸は「面積が大きい＝良い」極性に統一され（順調度 / 落ち着き=100−ストレス /
      コミュ効率=100−コスト）、生値（ストレス度・コミュニケーションコスト）も詳細として確認できる（D-3）
- [ ] 改善案は `user`（思考・行動）/ `environment`（ハーネス・環境整備）のカテゴリ付きで表示され、
      0件の場合は「改善案なし」を明示する
- [ ] 評価進行中（pending）はその旨が表示され、UI が無言のまま待たせない
- [ ] チャートは新規依存なしの React＋SVG 純コンポーネントで描画される（`package.json` に
      チャートライブラリが追加されていない）

## R-4: 遷移・総合（ダッシュボード）

- [ ] 評価ダッシュボードで週ごと・月ごとの軸別平均の遷移が表示できる（週=ISO週・月曜開始、
      月=暦月、ローカル時刻。`src/shared/evaluationAggregate.ts` の純関数、境界値の unit テスト
      —— 週跨ぎ・月跨ぎ・年跨ぎ）
- [ ] 全期間の総合評価（軸別平均・評価件数）が表示できる
- [ ] `skipped` / `error` の評価行は集計から除外される（unit テスト）
- [ ] 単発スコアの精度に関する注記（傾向を見るための指標である旨）が UI 上にある

## R-5: 出力先の選択

- [ ] 設定画面で評価レポートの出力先フォルダを設定・解除できる（`app_settings.evaluation_output_root`）。
      設定時はプローブ検証（書込可否）を行い、結果をユーザーに表示する
- [ ] 出力先設定時、評価確定（ok）ごとに Markdown＋JSON レポートが temp+rename で書き出される
      （`evaluationCoordinator` ＋ `src/shared/evaluationReport.ts` の純粋レンダリング、unit テスト）
- [ ] レポート書き出し失敗は評価自体を error にせず、`report_state='error'` として UI で確認できる
      （silent failure 禁止）
- [ ] 出力先未設定時はファイル書き出しを行わず、アプリ内表示のみで完結する
- [ ] 既存ファイルの上書き・削除経路がない（eval_id 単位の新規書き出しのみ）

## R-6: 不変条件

- [ ] `evaluations` は append-only: 再実行は新規行 INSERT。UPDATE は status 遷移
      （pending→ok/error/skipped）と report_state のみで、スコア書換・行削除の経路がない
      （`evaluationRepo.ts` の公開 API 面で確認）
- [ ] アーカイブ（スプール・ミラー）・元 JSONL への書き込みが一切発生しない（評価は読むだけ）
- [ ] 評価の JSON パース（LLM 応答・JSONL 抽出とも）は未知フィールド無視・欠落許容・
      スコア 0–100 クランプの寛容パーサである（`parseEvaluationResult`、不正入力の unit テスト）
- [ ] LLM 呼び出し・DB 書き込み・FS 書き込みは main の `evaluation/` 配下に集約され、
      renderer は IPC 契約（`src/shared/ipc.ts` の型付き channel）経由のみで触れる
- [ ] マイグレーション（`evaluations` テーブル追加）は既存 DB に対して無損失・idempotent
      （`schema.ts`、unit テスト）

## R-7: 再実行・失敗可視化

- [ ] claude 解決不能・タイムアウト・JSON 復元不能の各失敗で `status='error'` ＋ `last_error` が残り、
      UI にエラー内容が表示される（無音の 0 点評価にならない）
- [ ] エラー・完了済みの評価をユーザー操作で再実行でき、再実行は新規 `evaluations` 行を生む
- [ ] 目的ごとの現行評価は「最新の行」で決まり、過去の行も履歴として保持される

## E2E（Playwright + Electron）

- [ ] fake claude（canned JSON を返すスクリプトを claude パス設定で注入）で
      完了 → `evaluations` 行生成（ok・3軸値）→ ダイアログ表示、が通る
- [ ] 出力先を設定した状態で完了 → レポート `.md`/`.json` が出力先に生成される
- [ ] fake claude を失敗させた場合、error 状態が UI に表示され、再実行で回復する

## 回帰

- [ ] 完了操作・目的ライフサイクル（§4.6、TD-7）の既存挙動が変わらない
      （評価無効時は M8 までと同一動作）
- [ ] 既存の unit / E2E 回帰テストが全緑
