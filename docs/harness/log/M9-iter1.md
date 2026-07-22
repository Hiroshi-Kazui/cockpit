# M9 — iter1

日付: 2026-07-22
対象: 目的完了時の評価（3軸スコア・改善案・週次/月次遷移・出力先設定）

## 実装

`cockpit-implementer` による初回実装（IMPLEMENT M9）。Phase 1〜4（shared純関数 / main（DB・runner・coordinator）/
renderer（ダイアログ・ダッシュボード・設定）/ E2E）を実装。

変更/新規ファイル:
- shared: `evaluation.ts`, `evaluationAggregate.ts`, `evaluationReport.ts`（各+test）, `ipc.ts`（差分）
- main: `db/schema.ts`, `db/evaluationRepo.ts`, `db/appSettingsRepo.ts`, `db/sessionRepo.ts`,
  `evaluation/evaluationRunner.ts`, `evaluation/evaluationTranscriptReader.ts`,
  `evaluation/evaluationReportWriter.ts`, `evaluation/evaluationCoordinator.ts`（各+test）,
  `pty/purposeCoordinator.ts`（差分+test）, `ipc/handlers.ts`（差分+test）, `index.ts`（差分）
- preload: `index.ts`（差分）
- renderer: `RadarChart.tsx`, `EvaluationLineChart.tsx`, `EvaluationDialog.tsx`, `EvaluationDashboard.tsx`,
  `EvaluationSettings.tsx`, `hooks/useEvaluationForPurpose.ts`, `Pane.tsx`/`App.tsx`/`styles.css`（差分）
- e2e: `evaluation.spec.ts`（新規）, `fixtures/fake-claude.js`（差分）

## 静的ゲート

**環境制約**: サンドボックス環境で `npm install` を含むネットワークアクセス系コマンドが非対話実行のため
承認できずブロックされ、`node_modules` が存在しない。`tsc --noEmit` / `eslint` / `vitest run` /
`playwright test` を実測できなかった（実装エージェント・4レビュアーとも同一制約に直面）。
レビューはすべて静的読解ベースで実施し、各 verdict にその旨を明記させた。

## レビュー結果

| reviewer | status | score |
|---|---|---|
| code | PASS | 92 |
| architect | PASS | 93 |
| usability | PASS（自己申告。rubric 上は score<85 のため FAIL 扱い） | 79 |
| requirements | REQUEST_CHANGES（FAIL） | - |

### blocking（集約・重複統合）

- **[blocking]** `src/renderer/src/components/Pane.tsx` `handleComplete` が `evaluation_enabled` を
  確認せず完了成功後に無条件で `EvaluationDialog` を開く。無効時は評価行が生成されず push も来ないため
  ダイアログが「読み込み中…」を永続表示する（requirements: blocking／usability: major、同一問題として統合）。
  M8 までの「完了時にダイアログを開かない」動作からの回帰（acceptance.md 回帰項目・spec §4.6）。

### major（score<85 の主因、fix対象に含める）

- `src/renderer/src/components/EvaluationLineChart.tsx:33` — 空バケットを含まない集計を等間隔 x で描画し、
  時間ギャップをまたぐ傾きを歪める（傾向把握という本ビューの目的を損なう）。
- `src/renderer/src/App.tsx:178` — ペイン内 `EvaluationDialog` 表示中も Ctrl+1..4 のペインフォーカス
  ショートカットが抑止されず、モーダル背後の稼働中 pty へフォーカスが漏れる（他モーダルが守る不変条件の破れ）。

### non_blocking（今回は fix ループでは対応しない。合格時に followups.md へ）

- code: 読取経路の category 未検証キャスト／transcript 読取失敗と発言ゼロの区別なし／evaluation_model の
  charset 未制限／useEvaluationForPurpose の created_at 未考慮の上書き
- architect: `setEvaluationReportState` の防御ガード非対称／セッション読込の直列化／suggestion の index key
- usability: 出力先プローブの成功/検証中フィードバック欠如／レーダーと生値の対応関係の注記欠如／
  折れ線チャートの y 軸目盛・値・件数の欠如／精度注記のコントラスト不足／週次月次トグルの aria-pressed 欠如
- requirements: spec §4.6/§5 未反映（出荷時に対応予定）／CI 実機でのテスト実行結果未確認

## 最終判定

**FAIL**（4体すべて PASS かつ score>=85 の条件を満たさず）。blocking 1件 + major 2件を集約し、
`cockpit-implementer` へ FIX モードで差し戻し。反復カウンタ: 2/5。
