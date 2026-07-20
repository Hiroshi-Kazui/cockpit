---
milestone: M7
title: ミラーの hardening — M6 残課題の一括解消（per-root 進捗化含む）
status: draft   # draft → approved（/cockpit-build 起動 = 承認イベント）→ shipped（品質ゲート合格）
created: 2026-07-21
decisions: docs/adr/0009-per-root-mirror-progress.md
---

# M7 — ミラーの hardening（M6 残課題の一括解消）

## 1. 背景・要望

> 残課題をまとめて解決したい
> （2026-07-21 セッションでのユーザー発言。`/cockpit-plan` 起動時の要件）

M6（アーカイブ出力先の設定・ミラー）は品質ゲート合格・出荷済みだが、
`milestones/M6-archive-output/followups.md` に non_blocking の残課題14件が集約されている。
本マイルストーンはその**全件を一括解消**する。うち1件（per-root 進捗の完全 resume）は
データモデル変更を伴う設計級で、ADR-0009 として決定を起案した。

## 2. 要件

- R-1: 出力先 A→B→A の往復で、各 root の続きから自動 resume できる（per-root 進捗、ADR-0009）
- R-2: M6 followups の実装級13件（堅牢性5・UX/i18n 5・構造3）をすべて解消する
- R-3: M6 の全受け入れ基準・不変条件（append-only、無音破壊ゼロ、fire-and-forget、
  未設定時の M5 同一動作）を回帰させない

## 3. 設計判断

**設計級は ADR-0009 に記録済み**。要旨:

- `archive_mirror` を `(session_id, dest_root)` 複合 PK へ変更。起動時 idempotent マイグレーション
  （旧単一行を新形式へ INSERT SELECT、情報損失なし）
- content-prefix 照合（M6 反復3 の防御）は維持。per-root 行があっても復帰時は照合を通す
- sentinel（恒久エラー）と transient I/O 失敗を区別。一時失敗はリトライ、sentinel は照合不一致のみ
- spec §5 の更新は出荷時（`/cockpit-build` 合格処理）

実装級の方針（followups.md の各修正案に従う。新規決定なし）:

- 非同期の綻び: `rebaselineSession` 冒頭で `const sink = this.sink`（null ガード付き）捕捉に統一
- 診断保持: sentinel 行はリトライ再スケジュールを抑止（last_error 上書きと無駄タイマーを同時に解消）
- `readTranscriptPrefix`/`spoolReader` の `bytesRead` 検証＋短読みテスト
- i18n: ミラー系のユーザー向けエラー文言を日本語に統一（プローブ失敗・append-only 違反）
- UX: 「解除」hint に D-4（旧データは残る）明記 / opener 記録でフォーカス復帰先を分岐 /
  バックフィル開始直後の即時フィードバック表示 / エラーバッジのコントラスト調整
- 構造: `useMirrorStatus` を App 単一購読＋prop 渡しへ統合 / バックフィル時の status push を
  進捗イベントへ集約（O(N²) 解消）/ `startBackfill` の判定ロジックを `shared/` 純関数へ抽出

## 4. 実装フェーズ

### Phase 1: 契約・純関数・DB（unit test 込み。shared/ は test-first）
- `src/main/db/schema.ts`: `archive_mirror` 複合 PK 化＋旧形式からの idempotent マイグレーション
- `src/main/db/archiveMirrorRepo.ts`: `(session_id, dest_root)` キーの CRUD へ改修
- `src/shared/mirrorPlan.ts`: backfill 判定の純関数抽出（`computeBackfillPlan` 相当）、
  文言の日本語化。sentinel 定数の一元化（消費側から参照）

### Phase 2: ミラーエンジン（main）
- `mirrorCoordinator.ts`: per-root 行を前提に `rebaselineSession`/`syncTranscript`/`startBackfill` を
  整理（sink 冒頭捕捉、transient/permanent 区別、sentinel 行のリトライ抑止、status push 集約）
- `fsSink.ts`/`spoolReader.ts`: bytesRead 検証、プローブ失敗文言の日本語化

### Phase 3: renderer（UI/UX）
- `ArchiveOutputSettings.tsx`: 「解除」説明、バックフィル即時フィードバック
- `App.tsx`/`StatusBar.tsx`: opener 記録のフォーカス復帰、`useMirrorStatus` 単一購読化
- `styles.css`: エラーバッジのコントラスト調整

### Phase 4: E2E・出荷時整合
- A→B→A 完全 resume の検証（unit は必須、E2E は切替フローで確認）
- マイグレーション（旧形式 DB → 新形式）の unit テスト
- 出荷時: spec §5 を ADR-0009 の形へ更新、ADR-0009 を accepted 化、
  followups.md の解消項目に処理済みを記す、本ファイル `status: shipped`

## 5. 受け入れ基準

`acceptance.md`（同ディレクトリ）を参照。requirements-reviewer の逐条トレース対象。

## 6. リスク

- 複合キー移行は既存ユーザーの DB を書き換える。idempotent・情報無損失を unit テストで担保する
- per-root 行の増加により状態 UI/backfill の対象絞り込み（現在 root のみ）を誤ると
  旧 root の行が混入表示される。UI 仕様は「現在の出力先の状態のみ表示」で固定
- 14件の同時変更で M6 回帰のリスクが上がる。M6 の既存回帰テスト群（404 tests）を全緑維持

## 7. スコープ外

- Google Drive API 直結（`DriveApiSink`）— 引き続き将来拡張
- バックフィルのキャンセル機能（今回は即時フィードバック＋長時間注意書きまで。中断は将来）
- スプールの容量管理・ローテーション
