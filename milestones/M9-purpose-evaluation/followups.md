# M9 残課題（followups）

ビルドループ終了時（2026-07-22、合格・iter2）に残った non_blocking。次回 `/cockpit-plan` が起案時に参照する。
すべて blocking ではない（合格を妨げない）。

## major

- **[major] `PurposeDialog` 表示中も Ctrl+1..4 が抑止されない** — `src/renderer/src/components/Pane.tsx:305`
  付近。目的入力ダイアログ（`role=dialog aria-modal=true`）表示中、`EvaluationDialog` 用に本マイルストーンで
  追加した抑止経路（`onEvaluationDialogVisibilityChange` → `App.tsx` の `usePaneFocusShortcuts` enabled 条件）
  が `PurposeDialog` には適用されておらず、Ctrl+1..4 で背後の別ペインの稼働中 pty へフォーカスが飛ぶ。
  aria-modal の約束に反する。修正案: `onPurposeDialogVisibilityChange` を同様に追加し、
  `evaluationDialogOpenPanes` と同型の集合に統合するか並置する。

## minor（main・データ層）

- **[minor] `evaluationRepo.ts` 読取経路が suggestion category を未検証でキャスト** — `parseSuggestionsJson`
  （書込経路の `parseEvaluationResult` は厳密検証済みだが、DB 読取側は 'user'|'environment' か検証せず
  `EvaluationSuggestion` にキャスト）。手編集・破損行があると `EvaluationDialog.tsx` の `CATEGORY_LABEL[s.category]`
  が undefined になり得る（クラッシュはしない）。修正案: 読取側も許容カテゴリで絞り込む。
- **[minor] `evaluationTranscriptReader.ts` の読取失敗と「発言ゼロ」が区別できない** — スプールファイルが
  存在するが権限等で読取失敗した場合も空扱いとなり、全セッションで起きると `error` でなく `skipped` に
  分類され得る（`input_stats` の `sessionCount>0/userMessageCount=0` で間接的に区別は可能）。
  修正案: FS 実失敗と「発言ゼロ」を stats 上で明示的に区別するフラグを持たせる。
- **[minor] `evaluationRunner.ts` の `evaluation_model` に文字集合制限がない** — ユーザー設定可能で argv に
  載る（TD-5 が禁じる「目的/transcript 由来の動的文字列」ではないためインジェクション不変条件には抵触しないが、
  `titleGenerator` の固定 `'haiku'` と異なり自由文字列）。修正案: `setEvaluationModel` で安全な文字集合に制限する。
- **[minor] `evaluationRepo.ts` の `setEvaluationReportState` に防御ガードの非対称** — `finalizeOk`/`finalizeError`
  が持つ `WHERE status='pending'` 型の一度きりガードを欠き、任意 status の行の `report_state` を更新しうる
  （実運用では coordinator が finalizeOk 後にしか呼ばないため安全）。修正案: `WHERE id=? AND status='ok'` を付す。
- **[minor] `evaluationCoordinator.ts` のセッション transcript 読込が直列** — fire-and-forget の背景処理ゆえ
  実害はないが、目的に紐づくセッション数が多い場合 `Promise.all` 化の余地がある。

## minor（renderer・UX）

- **[minor] `EvaluationSettings.tsx` の出力先プローブに成功/検証中フィードバックがない** — 失敗時のみ
  メッセージ表示、成功はパス文字列の更新のみで暗示。R-5 の「結果をユーザーに表示する」に対し成功時の
  明示メッセージと「検証中…」表示があるとよい。
- **[minor] レーダー（落ち着き/コミュ効率）と生値（ストレス度/コミュニケーションコスト）の `100−x` 対応が
  UI 上に明示されない** — `EvaluationDialog.tsx`。一文の注記があると誤解を防げる。
- **[minor] `EvaluationLineChart.tsx` に y 軸目盛・各点の値・バケット件数の表示がない** — 少数サンプル平均と
  多サンプル平均が同じ見た目になり信頼度差が読めない。加えて、iter2 で等間隔配置から時刻比例配置へ変更した
  副作用として、時間的に近接したバケットの x ラベルが重なり得るようになった。修正案: y 軸ラベル・値・件数の
  併記、ラベル間引き/回転や `title` 属性の付与。
- **[minor] 「評価は単発スコアで精度を保証しない」注記のコントラストが低い**（`styles.css` の
  `evaluation-dialog__disclaimer` 等、10.5px・#9d9d9d 相当）— 最重要の注記であるにもかかわらず最も読みにくい。
- **[minor] `EvaluationDashboard.tsx` の週次/月次トグルに `aria-pressed` がない** — スクリーンリーダーで
  現在の選択状態が伝わらない。
- **[minor] `EvaluationDialog.tsx` の evaluationEnabled 取得が Pane.tsx と重複し、フォールバック挙動が
  微妙に分岐**（Pane は非オープン／Dialog は true 仮定）— `useEvaluationEnabled()` フックへ抽出し
  `useUsageSettings` 規約に揃えるとよい。mount 時1回のみの取得で購読しないため、行が存在しない状態で
  ダイアログを開いたまま設定をトグルしても表示が追従しない点も含む。
- **[minor] `EvaluationDialog.tsx` に evaluationEnabled と評価行取得の非同期解決順の競合による一瞬の
  ちらつき** — 評価済みだが現在トグル off の目的を手動オープンした瞬間に「評価は現在無効です」が一瞬表示され
  直後に結果へ差し替わり得る（M8 回帰ではない）。修正案: 初期ロード未完フラグを設け、評価行 read 完了前は
  無効分岐より読み込み中を優先する。
- **[minor] `EvaluationDialog.tsx` の suggestion リストが配列 index を key に使用** — 現状は静的リストで
  無害だが、将来の並べ替え耐性のため安定キーを検討。
- **[minor] `EvaluationDashboard.tsx` の `series`/`points` が毎レンダー再生成**（未 memo 化、既存パターン踏襲のため実害小）。
- **[minor] `Pane.tsx` の `showEvaluation` と可視性通知の理論上の desync**（`purposesByPane` からエントリが
  削除されないため実際には到達不能。防御的な観点のみ）。
- **[minor] `EvaluationDialog.tsx` — 設定読み取り失敗かつ評価行が永遠に来ない場合「読み込み中…」に留まりうる**
  （安全側の設計として意図的だが、タイムアウト表示へのフォールバックを将来検討）。

## 環境・プロセス

- **[minor] CI/実機でのツールチェーン実測が未実施** — 本ビルドループはサンドボックス環境で `npm install`
  が非対話実行のため承認できず、`tsc --noEmit` / `eslint` / `vitest run` / `playwright test` を
  実測できなかった（実装・4レビュアーとも同一制約）。全判定は静読ベース。マージ前に CI もしくは
  npm 系コマンドを許可した環境で実測グリーンを確認すること。
