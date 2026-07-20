# M7 受け入れ基準 — ミラーの hardening（M6 残課題の一括解消）

requirements-reviewer の逐条トレース基準であり、implementer の実装スコープ定義。
各項目は「どのファイル/関数が満たすか」を特定できなければ未達扱い。
共通ゲート: `tsc --noEmit`（node/web）/ `eslint` / `vitest run` / `playwright test` が green。
出典は `milestones/M6-archive-output/followups.md`（14件）＋ ADR-0009。

## per-root 進捗（ADR-0009、設計級）

- [ ] `archive_mirror` の主キーが `(session_id, dest_root)` 複合キーである（`src/main/db/schema.ts`）
- [ ] 旧形式（session_id 単一 PK）の既存 DB が起動時に idempotent マイグレーションで新形式へ移行され、
      既存行の情報が失われない（unit テストで旧→新移行を検証）
- [ ] 出力先 A→B→A 往復後、root A の続きから自動 resume され最終的に宛先 A がスプールと一致する
      （unit 必須。M6 で permanent-block だったケースが resume に変わることを回帰テストで明示）
- [ ] 復帰時も content-prefix 照合（記録進捗と宛先実サイズの一致検証＋先頭バイト照合）を通る。
      照合不一致（宛先の外部改変）は従来どおり `state='error'` で恒久ブロック、宛先無変更
- [ ] 状態 UI・バックフィルの対象が「現在の出力先の行」に絞られ、旧 root の行が混入表示されない

## 堅牢性（followups: major 1 + minor 4）

- [ ] `rebaselineSession` がメソッド冒頭で `const sink = this.sink`（null ガード付き）を捕捉し、
      await 跨ぎの `this.sink` live 参照・`this.sink!` 非 null 断定が存在しない（`mirrorCoordinator.ts`）
- [ ] 宛先の stat/read の一時的失敗（transient I/O）は sentinel へ昇格せずリトライされる。
      sentinel は content 照合不一致のみ（unit テストで両分岐を検証）
- [ ] sentinel（恒久エラー）状態の行はリトライ再スケジュールされない（無駄タイマーなし）。
      これにより診断 last_error（照合不一致の説明）が汎用メッセージで上書きされない
- [ ] sentinel 定数が一元化され、消費側（backfill 比較等）が定数参照でコメント付き
- [ ] `readTranscriptPrefix`（fsSink）/ spoolReader の読み取りが `bytesRead` を検証し、
      短読み・中間長のテストがある

## UX・i18n（followups: minor 5）

- [ ] ミラー系のユーザー向けエラー文言が日本語に統一されている（プローブ失敗の生 errno、
      append-only 違反 reason。`fsSink.ts` / `shared/mirrorPlan.ts`）
- [ ] 「解除」の hint に旧出力先のデータが残る旨（削除ではない、D-4）が明記されている
      （`ArchiveOutputSettings.tsx`）
- [ ] ダイアログを StatusBar のインジケータから開いた場合、閉じたときのフォーカスがその
      インジケータへ戻る（opener 記録。ヘッダボタンから開いた場合は従来どおりボタンへ）
- [ ] バックフィル開始直後に即時フィードバック（開始した旨）が表示され、長時間になり得る旨の
      注意書きがある（初回進捗イベント到着前の空白がない）
- [ ] エラーバッジのコントラストが調整されている（`styles.css`。文言冗長化は維持）

## 構造・効率（followups: minor 3）

- [ ] `useMirrorStatus` の購読が1系統（App 保持＋prop 渡し等）に統合され、二重フェッチ・二重購読がない
- [ ] バックフィル中の per-session status push が進捗イベントに集約され、
      セッション数 N に対し O(N²) の DB クエリ/push が発生しない
- [ ] `startBackfill` の実行可否判定が `shared/` の純関数として抽出され、unit テストがある

## 回帰（R-3）

- [ ] M6 の受け入れ基準13項目が引き続き満たされる（未設定時 M5 同一動作・append-only・
      fire-and-forget・クラッシュ復旧・切断→復旧追い付き・バックフィル suffix 拒否を含む）
- [ ] M6 で追加された回帰テスト（起動時復旧・A→B→A・backfill suffix・モーダルフォーカス）が全緑
- [ ] E2E（Playwright）全スイート green
