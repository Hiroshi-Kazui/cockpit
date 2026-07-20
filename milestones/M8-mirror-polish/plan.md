---
milestone: M8
title: M7 残課題の解消（ミラーの磨き込み）
status: draft   # draft → approved（/cockpit-build 起動 = 承認イベント）→ shipped（品質ゲート合格）
created: 2026-07-21
decisions: docs/adr/0008-archive-mirror.md, docs/adr/0009-per-root-mirror-progress.md
---

# M8 — M7 残課題の解消（ミラーの磨き込み）

## 1. 背景・要望

> 残課題を解決
> （2026-07-21 セッションでのユーザー発言。`/cockpit-plan` 起動時の要件）

M7（ミラーの hardening）は品質ゲート合格・出荷済み。`milestones/M7-mirror-hardening/followups.md` に
non_blocking の minor が8件残っている（blocking・major はゼロ）。本マイルストーンはその全件を解消する。
**新規の技術決定は無い**（すべて既存 ADR-0008/0009 の範囲内の実装・磨き込み）。

## 2. 要件

- R-1: M7 followups の minor 8件をすべて解消する
- R-2: M6/M7 の全受け入れ基準・不変条件（append-only、無音破壊ゼロ、fire-and-forget、
  per-root resume、未設定時の M5 同一動作）を回帰させない

## 3. 設計判断

新規決定なし。followups.md の各修正案に従う。唯一、方針を明確化する点:

- **D-1（destSize=0 エッジの扱い）**: `computeResumeVerificationRange` で「宛先実サイズ=0 かつ記録進捗>0」
  （＝宛先が外部削除された疑い）を**楽観採用せず、`state='error'`（再バックフィル要求）として明示**する。
  append-only 設計下で先頭欠落の不完全ミラーを無音生成しないため。既存の suffix-refuse と同じ「安全側で
  明示エラー」の一貫方針であり、新規決定ではなく既存不変条件（無音破壊ゼロ）の徹底。
  なお「宛先を空で新規設定した直後で record も0」の正当ケースは destSize=0 かつ recordedSyncedBytes=0 で
  区別できるため誤検出しない。

## 4. 実装フェーズ

### Phase 1: 純関数・契約（test-first）
- `src/shared/mirrorPlan.ts`: `computeResumeVerificationRange` に destSize=0 かつ recordedSyncedBytes>0 の
  error 分岐を追加（純関数、unit test 先行）

### Phase 2: ミラーエンジン（main）
- `mirrorCoordinator.ts`:
  - `startBackfill` の外側 catch で `recordError(sessionId, root, err)` を呼び `last_error` を残してから
    `failedSessions++`（silent failure 解消、D-5）
  - `retryTimers`/`retryDelays` を operation 種別（verify / sync）を含むキーに変更、または種別ごとに分離し、
    2種の retry が互いを上書きしないようにする
  - `rebaselineSession` の sink 冒頭捕捉と root 引数の非対称に1行説明コメント追加
- `fsSink.ts` / `spoolReader.ts`: 残る防御的 throw 文言（append-only ガード / sessionDir "refusing to mirror" /
  "invalid session id" / "short read"）を日本語リード文＋原文括弧温存で日本語化（`describeProbeErrno` と同形式）

### Phase 3: renderer（UX）
- `App.tsx`: StatusBar インジケータ起点で開いたダイアログ内で「解除」して閉じた場合、
  `mirrorIndicatorButtonRef` が失効（unmount）していればヘッダボタン等へフォーカスをフォールバック
- `ArchiveOutputSettings.tsx`: バックフィル進捗表示中にも「時間がかかる場合があります」の控えめな継続注記を出す

### Phase 4: E2E・出荷時整合
- **E2E（Playwright + Electron）: 起動時マイグレーションの検証**。旧形式（session_id 単一 PK）の
  `archive_mirror` を持つ DB を seed して実アプリを起動し、複合キーへ無損失移行され起動が成功することを確認
  （FakeDatabase の unit では届かない、実 better-sqlite3 での移行検証。M7 followups のテスト制約を解消）
- 出荷時: spec との齟齬確認（データモデルは M7 で複合キー化済み、本 M8 で変更なし）、`status: shipped`

## 5. 受け入れ基準

`acceptance.md`（同ディレクトリ）を参照。requirements-reviewer の逐条トレース対象。

## 6. リスク

- 8件が広く散るため回帰リスクがある。M6/M7 の既存回帰テスト群（428 tests）を全緑維持
- E2E マイグレーション検証は実 better-sqlite3・Electron 起動を要するため、seed DB の作り方（旧スキーマ DDL）を
  テストヘルパで正確に用意する必要がある

## 7. スコープ外

- Google Drive API 直結（DriveApiSink）
- バックフィルのキャンセル機能
- スプールの容量管理・ローテーション
- 新規機能（本 M8 は既存挙動の磨き込みに限定。先取り実装しない）
