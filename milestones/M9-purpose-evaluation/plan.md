---
milestone: M9
title: 目的完了時の評価（3軸スコア・改善案・週次/月次遷移・出力先設定）
status: draft   # draft → approved（/cockpit-build 起動 = 承認イベント）→ shipped（品質ゲート合格）
created: 2026-07-23
decisions: docs/adr/0010-purpose-evaluation-pipeline.md
---

# M9 — 目的完了時の評価（3軸スコア・改善案・週次/月次遷移・出力先設定）

## 1. 背景・要望

> 目的達成ごとの評価　評価軸は順調度、ユーザ側の入力から垣間見えるストレス度、エージェントとのコミュいケーションコスト
> 改善案は、ユーザ側への思考・行動、ハーネス設計などの環境整備など
> 分析結果は週ごと月ごとの遷移、総合評価も可能。
> 評価の出力先も選択可能にする
> （2026-07-23 セッションでのユーザー発言。`/cockpit-plan` 起動時の要件。同セッションの先行議論で
> 「goal完了時、セッション中のコンテキストを分析して…スパイダーチャート形式で表示し、あれば改善案を提示」）

spec §2 は「応答への満足・不満の評価UI」をスコープ外とするが、その括弧書きは
「判断はアーカイブされたユーザ発言の内容から事後に行う」と**事後分析を予告**している。
本マイルストーンはその「事後に行う」側を実装する。会話への介入・加工は引き続き一切行わない。
出荷時、spec の責務記述（§1/§2「起動・表示・記録」）に「記録の事後分析（目的完了時の評価）」を
加える更新が必要（spec 更新は `/cockpit-build` 合格処理の責務）。

## 2. 要件

- **R-1（評価の実行）**: 目的の「完了」操作を契機に、その目的に紐付く全セッションのアーカイブ
  （スプール JSONL＋メタデータ）を入力として評価を自動実行する。評価軸は
  **順調度 / ストレス度（ユーザ入力から推定） / エージェントとのコミュニケーションコスト**の3軸
  （各 0–100 の整数）。実行は非同期・fire-and-forget で、ペイン操作・記録経路を一切ブロックしない
- **R-2（完了時の表示）**: 評価完了時、スパイダーチャート（レーダーチャート）＋総評＋改善案を
  ダイアログ表示する。進行中・失敗も可視化する（silent failure 禁止）
- **R-3（改善案）**: 改善案はカテゴリ付きで提示する。カテゴリは
  `user`（ユーザ側の思考・行動） / `environment`（ハーネス設計・開発環境整備）。0件も許容
- **R-4（遷移・総合）**: 評価ダッシュボードで週ごと・月ごとの軸別平均の遷移と、
  全期間の総合評価（軸別平均・評価件数）を表示できる
- **R-5（出力先の選択）**: 評価レポート（Markdown＋JSON）の出力先フォルダをユーザーが設定できる。
  未設定ならアプリ内表示のみ。出力失敗は評価自体を失敗させず、状態として可視化する
- **R-6（不変条件）**: append-only（評価の再実行は新規行の追加。削除・編集経路を設けない）、
  元 JSONL 非改変、pty 素通し非干渉、寛容パーサ、副作用の集約、を全て維持する
- **R-7（再実行・失敗可視化）**: 評価失敗（claude 解決不能・タイムアウト・JSON 不正 等）は
  `error` 状態＋原因を UI に表示し、手動で再実行できる

## 3. 設計判断の要旨（本文は ADR-0010）

- **D-1 トリガ**: `PurposeCoordinator.completePurpose` 成功後に評価ジョブを起動（fire-and-forget）。
  入力はアーカイブ（スプール）のみから読む。pty・元 JSONL には触れない
- **D-2 エンジン**: titleGenerator と同型のヘッドレス `claude -p --model <model>` 1ショット。
  プロンプトは **stdin 渡しのみ**（argv に動的文字列を載せない — TD-5 由来のインジェクション不変条件を踏襲）。
  応答は JSON を要求し、寛容パーサで検証（未知フィールド無視・欠落許容・スコアは 0–100 にクランプ）。
  既定モデル haiku、`app_settings.evaluation_model` で変更可。`evaluation_enabled`（既定 ON）で機能ごと無効化可
- **D-3 極性と表示**: DB には要件どおりの生値を保存（ストレス度・コミュニケーションコストは高いほど悪い）。
  レーダー表示は「面積が大きい＝良い」に統一するため、順調度 / 落ち着き(100−ストレス度) /
  コミュ効率(100−コミュニケーションコスト) へ変換して描画し、生値は詳細表示に併記する
- **D-4 保存**: 新テーブル `evaluations`（append-only。再実行は新規行、目的ごとの最新行が現行評価）
- **D-5 出力先**: `app_settings.evaluation_output_root`（任意）。評価確定ごとに
  `<root>/<eval_id>.md` / `.json` を temp+rename で書き出す write-through。
  レポートは SQLite から常に再生成可能な派生物なので、アーカイブミラーの resume/backfill 機構は流用しない。
  設定時はプローブ検証（ADR-0008 D-5 と同型）。アーカイブミラーの root とは独立した設定
- **D-6 集計**: 週＝ISO 週（月曜開始・ローカル時刻）、月＝暦月（ローカル時刻）。バケット化・平均・
  総合は `shared/` の純関数（タイムゾーンオフセットを引数に取り決定的にテスト可能）
- **D-7 チャート**: 新規依存を追加しない。React＋SVG の手書き純コンポーネント（3軸レーダー・折れ線）
- **D-8 入力構築**: transcript 全文は送らない。純関数が「ユーザ発言を全量優先、アシスタント発言は
  先頭/末尾抜粋、総量上限」で決定的に評価入力を構築。入力が実質空（発言なし）の場合は
  LLM を呼ばず `skipped` 状態で確定する

**要件解釈の明示**（起案者判断。異論があれば build 前に指摘を）:
「評価の出力先も選択可能にする」は「評価レポートファイルの書き出し先フォルダを設定可能にする
（未設定＝アプリ内表示のみ）」と解釈した。クラウドへはアーカイブミラー同様、同期クライアントの
フォルダを指定することで実現する。

## 4. データモデル追加（出荷時に spec §5 へ反映）

```
evaluations
  id                TEXT PRIMARY KEY   -- UUID
  purpose_id        TEXT               -- purposes.id への参照
  created_at        INTEGER
  model             TEXT NULL          -- 実際に使ったモデル
  status            TEXT               -- 'pending' | 'ok' | 'error' | 'skipped'
  smoothness        INTEGER NULL       -- 順調度 0-100
  stress            INTEGER NULL       -- ストレス度 0-100（高いほど悪い）
  comm_cost         INTEGER NULL       -- コミュニケーションコスト 0-100（高いほど悪い）
  summary           TEXT NULL          -- 総評（短文）
  suggestions_json  TEXT NULL          -- [{category:'user'|'environment', text}] の JSON
  input_stats_json  TEXT NULL          -- 入力の定量スナップショット（セッション数・発言数・累計トークン等）
  last_error        TEXT NULL
  report_state      TEXT NULL          -- 出力先レポート: NULL(対象外) | 'written' | 'error'

app_settings 追加キー: evaluation_enabled / evaluation_model / evaluation_output_root
```

## 5. 実装フェーズ

### Phase 1: 契約・純関数（test-first）
- `src/shared/ipc.ts`: `EvaluationSummary` / `EvaluationSuggestion` / 集計型 / IPC channel 追加、
  `AppSettings` に評価設定を追加
- `src/shared/evaluation.ts`（新規）: `buildEvaluationInput`（D-8 の決定的抜粋・上限）、
  `buildEvaluationPrompt`、`parseEvaluationResult`（寛容パース・クランプ・カテゴリ検証）
- `src/shared/evaluationAggregate.ts`（新規）: 週/月バケット化・軸別平均・総合集計（D-6）
- `src/shared/evaluationReport.ts`（新規）: Markdown/JSON レポートの純粋レンダリング
- いずれも実装前にテストを書き red → green

### Phase 2: main
- `src/main/db/schema.ts`: `evaluations` テーブルのマイグレーション追加
- `src/main/db/evaluationRepo.ts`（新規）: insert / 目的別最新 / 期間 list（append-only、UPDATE は
  status 遷移（pending→ok/error/skipped）と report_state のみ。行の削除・スコア書換の経路を作らない）
- `src/main/evaluation/evaluationRunner.ts`（新規）: titleGenerator と同型の execFile 注入可能な
  1ショット実行（stdin 渡し、タイムアウト、windowsHide）
- `src/main/evaluation/evaluationCoordinator.ts`（新規）: 完了トリガ受領 → sessionRepo から
  purpose_id のセッション収集 → スプール transcript 読込 → runner 実行 → repo 保存 →
  renderer へ push → 出力先設定時はレポート書き出し。副作用はここに集約
- `src/main/index.ts`: completePurpose 経路への配線、IPC handlers（最新評価取得・期間 list・再実行・設定）
- `src/main/ipc/handlers.ts` / `src/preload/index.ts`: 型付き契約の露出

### Phase 3: renderer
- 評価ダイアログ（新規コンポーネント）: レーダーチャート（SVG）・総評・カテゴリ別改善案・
  pending/error/skipped の状態表示・再実行ボタン
- 評価ダッシュボード（新規ビュー）: 週/月切替の遷移チャート（折れ線）＋総合評価。
  評価が主観的な単発値である旨の注記（過剰解釈の抑止）
- 設定画面: 評価の有効/無効・モデル・出力先（プローブ検証＋結果表示）

### Phase 4: E2E・出荷時整合
- E2E（Playwright + Electron）: fake claude（canned JSON を返すスクリプトを claude パス上書きで注入）で
  「完了 → 評価行生成 → ダイアログ表示」「出力先設定時のレポート生成」「fake 失敗時の error 可視化＋再実行」
- 出荷時: spec §1/§2（責務への事後分析の追記）・§4 新節（評価）・§5（データモデル）・§7（リスク）更新、
  `status: shipped`（`/cockpit-build` の責務）

## 6. リスク

- **LLM 出力の不安定さ**: JSON が崩れる・軸が欠ける。寛容パーサ＋クランプで吸収し、
  復元不能なら `error`（再実行可）。無音の 0 点扱いはしない
- **評価の主観性**: 単発スコアの精度は保証できない。価値の重心は遷移（R-4）に置き、UI に注記する
- **transcript 肥大**: 入力上限で決定的に切る（D-8）。切ったことは input_stats に記録し隠さない
- **トークン消費**: 完了ごとに1ショット追加。既定 haiku・無効化トグルで制御
- **JSONL 非公開仕様**: 既存リスク（spec §7）と同じ。評価入力の抽出も寛容パーサ経由で行う
- **完了操作の応答性**: 評価は完了処理と分離した fire-and-forget であり、完了操作自体を遅延させない

## 7. スコープ外

- 過去の完了済み目的への一括評価（バックフィル評価。トークン消費が読めないため、
  必要なら明示操作として別マイルストーンで検討）
- 週次/月次集計結果のファイル出力（出力先へ書くのは目的ごとのレポートのみ）
- 評価結果の grill-me・CLAUDE.md 等への自動フィードバック（改善案の適用はユーザの判断）
- セッション進行中のリアルタイム評価・介入（spec §2 の不介入原則を維持）
- 評価軸の追加・カスタマイズ UI（3軸固定。拡張はレーダー描画が N 軸対応の純関数である範囲で将来）
