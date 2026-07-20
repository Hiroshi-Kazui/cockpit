# M8 受け入れ基準 — M7 残課題の解消（ミラーの磨き込み）

requirements-reviewer の逐条トレース基準であり、implementer の実装スコープ定義。
各項目は「どのファイル/関数が満たすか」を特定できなければ未達扱い。
共通ゲート: `tsc --noEmit`（node/web）/ `eslint` / `vitest run` / `playwright test` が green。
出典は `milestones/M7-mirror-hardening/followups.md`（minor 8件）。

## 堅牢性・silent failure

- [ ] バックフィルの外側 catch が `recordError(sessionId, root, err)` で `last_error` を記録してから
      `failedSessions++` する（失敗理由が `archive_mirror.last_error` に残り UI で確認できる。`mirrorCoordinator.ts` の `startBackfill`）
- [ ] `computeResumeVerificationRange` が「destSize=0 かつ recordedSyncedBytes>0」を error（再バックフィル要求）として
      返し、宛先が外部削除された疑いのケースで先頭欠落の不完全ミラーを無音生成しない（`src/shared/mirrorPlan.ts`、unit テスト）。
      「destSize=0 かつ recordedSyncedBytes=0」の正当な新規設定直後は誤検出しない（unit テストで両分岐）

## i18n（防御的 throw 文言の日本語化）

- [ ] `fsSink.ts` の append-only 違反ガード throw と sessionDir "refusing to mirror" が日本語（原文は括弧で温存）
- [ ] `spoolReader.ts` の "invalid session id" / "short read" 等の throw が日本語（同上）
- [ ] `recordError` 経由で `last_error` として UI 露出し得るミラー系文言に英語が残っていない

## UX

- [ ] StatusBar のインジケータから設定を開き、ダイアログ内で出力先を「解除」して閉じた場合でも、
      フォーカスが body へ逃げずヘッダボタン等へフォールバックする（`App.tsx`。ref 失効時の分岐）
- [ ] バックフィルの進捗表示中にも「時間がかかる場合があります」の継続注記が控えめに表示される
      （`ArchiveOutputSettings.tsx`。初回進捗到着後も所要見込みが分かる）

## 構造・テスト

- [ ] `retryTimers`/`retryDelays` が operation 種別（verify / sync）を区別し、同一 session の2種の retry が
      互いのタイマーを上書きしない（`mirrorCoordinator.ts`）
- [ ] `rebaselineSession` の sink 冒頭捕捉と root 引数の非対称に、意図を説明する1行コメントがある（`mirrorCoordinator.ts:208` 付近）
- [ ] E2E（Playwright + Electron）で、旧形式（session_id 単一 PK）の `archive_mirror` を持つ DB を seed して
      実アプリを起動 → 複合キーへ無損失移行され起動成功、を検証する（実 better-sqlite3 での起動時マイグレーション検証。
      M7 の FakeDatabase テスト制約を解消）

## 回帰

- [ ] M6/M7 の受け入れ基準が引き続き満たされる（append-only・無音破壊ゼロ・fire-and-forget・per-root resume・
      未設定時 M5 同一動作・クラッシュ復旧・A→B→A resume・マイグレーション無損失/idempotent）
- [ ] 既存の unit / E2E 回帰テスト（M8 前 428 unit + E2E）が全緑
