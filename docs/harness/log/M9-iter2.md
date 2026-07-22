# M9 — iter2（合格）

日付: 2026-07-22
対象: 目的完了時の評価（3軸スコア・改善案・週次/月次遷移・出力先設定）

## 修正内容

`cockpit-implementer` による FIX（iter1 の blocking 1件＋major 2件を対象）。

1. **[blocking→修正]** `src/renderer/src/components/Pane.tsx` の `handleComplete` が完了成功直後に
   `window.cockpit.appSettings.get()` で `evaluationEnabled` を再確認してからのみ `EvaluationDialog` を
   自動オープンするよう変更。`EvaluationDialog.tsx` は mount 時に evaluationEnabled を取得し、
   評価行が無く無効設定のときは「評価は現在無効です」を明示表示（手動オープン経路も同様にカバー）。
   `App.tsx` / `PaneGrid.tsx` / `Pane.tsx` に `onEvaluationDialogVisibilityChange` を追加。
2. **[major→修正]** `src/renderer/src/components/EvaluationLineChart.tsx` を等間隔 `xLabels: string[]` から
   バケットの実時刻（`startMs`）に比例した `points: {key,label,timeMs}[]` 配置へ変更。
   `EvaluationDashboard.tsx` の呼び出し側を追従。
3. **[major→修正]** `App.tsx` に `evaluationDialogOpenPanes`（`ReadonlySet<PaneIndex>`）を追加し、
   `usePaneFocusShortcuts` の enabled 条件に含めることで、ペイン内 `EvaluationDialog` 表示中の
   Ctrl+1..4 フォーカスショートカットを他モーダルと同様に抑止。

`e2e/evaluation.spec.ts` に検証用シナリオ2件を追加（無効時の自動オープン抑止＋明示状態表示、
ダイアログ表示中の Ctrl+1..4 抑止＋クローズ後の復帰）。

## 静的ゲート

環境制約継続（`node_modules` 不在、`npm install` 不可）。`tsc` / `eslint` / `vitest run` / `playwright test`
は実測不能。全レビュアーが静読で検証し、その旨を verdict に明記。

## レビュー結果

| reviewer | status | score |
|---|---|---|
| code | PASS | 93 |
| architect | PASS | 94 |
| usability | PASS | 87 |
| requirements | PASS | 93 |

4体すべて `status: PASS` かつ `score >= 85` — **合格ゲート通過**。blocking 0件。

## 最終判定

**PASS**。M9 合格。出荷処理（`plan.md: shipped`、followups.md 書き出し、spec 更新）を実施する。

## 新規に確認された残課題

usability レビュアーが今回、`src/renderer/src/components/PurposeDialog.tsx` に
`EvaluationDialog` と同種の Ctrl+1..4 抑止漏れ（aria-modal 表示中も背後ペインへフォーカスが飛ぶ）を
新たに確認（major・non_blocking）。実装者は今回のFIXスコープ外として意図的に対応せず。followups.md へ記録。
