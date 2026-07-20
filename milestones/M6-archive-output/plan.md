---
milestone: M6
title: アーカイブ出力先の設定可能化（クラウドストレージ対応）
status: shipped   # draft → approved（/cockpit-build 起動 = 承認イベント）→ shipped（品質ゲート合格）
created: 2026-07-20
decisions: docs/adr/0008-archive-mirror.md
---

# M6 — アーカイブ出力先の設定可能化（クラウドストレージ対応）

## 1. 背景・要望

> コンテキストの出力先を自由に設定できるようにしたい。GoogleDrive などのインターネット上のストレージにも
> （2026-07-20 セッションでのユーザー発言）

従来はアーカイブ先が `app.getPath('userData')/archive/<session_id>/` に固定
（実装は `src/main/index.ts` の `archiveRootDir()`）。ユーザーが出力先を選べず、
クラウドストレージへの保存手段がない。

## 2. 要件

- R-1: アーカイブ出力（`transcript.jsonl` ＋ `metadata.json`）の出力先をユーザーが設定できる
- R-2: Google Drive 等のインターネット上のストレージへ保存できる
- R-3: 既存の不変条件を維持する — append-only、元 JSONL 非改変、ハーネス素材としての完全性
- R-4: 出力先の不調（オフライン・遅延・ロック）が記録の完全性・claude の対話 UX を損なわない

## 3. 設計判断

**docs/adr/0008-archive-mirror.md に D-1〜D-6 として記録済み**（本プランが起案元）。要旨:

- D-1: 設定対象はアーカイブ出力のみ。SQLite DB は userData 固定
- D-2: ローカルスプール主 + 非同期ミラー（結果整合）。クラウドへの直接 append はしない
- D-3: クラウドは同期クライアント経由（Tier 1）。API 直結は `ArchiveSink` 抽象で将来拡張（Tier 2、スコープ外）
- D-4: 出力先変更時、過去ミラーは移動・削除しない。過去分は明示操作のバックフィルのみ
- D-5: 出力先はプローブ検証。スプール配下は指定不可。同期状態を UI 表示（silent failure 禁止）
- D-6: `app_settings.archive_output_root` ＋ `archive_mirror` テーブル。ミラー先構造はスプールと同一

spec への反映は §4.4.1 / §5 / §7 に済み（本機能は設計先行で spec に記述済み。
出荷時に実装と spec の最終整合を確認する）。

## 4. 実装フェーズ

### Phase 1: 契約・DB・純関数（unit test 込み）

- `src/shared/ipc.ts`: `AppSettings` に `archiveOutputRoot` 追加、
  `cockpit:archive:set-output-root` / `cockpit:archive:mirror-status` / `cockpit:archive:backfill`
  チャネルと payload 型を追加
- `src/main/db/schema.ts`: `archive_mirror` テーブル（idempotent DDL）
- `src/main/db/appSettingsRepo.ts`: `archive_output_root` の get/set
- `src/main/db/archiveMirrorRepo.ts`（新規）: archive_mirror CRUD
- `src/shared/mirrorPlan.ts`（新規・純関数）: スプール状態（ファイルサイズ）とミラー進捗から
  「次にコピーすべき差分」を計算。出力先パスの妥当性判定（スプール配下拒否）もここ

### Phase 2: ミラーエンジン（main プロセス）

- `src/main/archive/mirror/sink.ts`（新規）: `ArchiveSink` インターフェース
  （`appendTranscript(sessionId, buffer, offset)` / `writeMetadata(sessionId, json)`）
- `src/main/archive/mirror/fsSink.ts`（新規）: ローカル/マウントパス向け実装。
  追記は「offset 検証 → append」。ミラー先ファイルがスプールより大きい場合は
  エラー状態にして上書きしない（append-only 違反の検出）
- `src/main/archive/mirror/mirrorCoordinator.ts`（新規）: 同期キュー。
  - `SessionArchiver` の `onEntries`（追記検知）と `DebouncedMetadataWriter` の書き込みを購読
  - デバウンス（追記の度ではなく静止後にまとめて同期）
  - 失敗時は指数バックオフでリトライ、`archive_mirror.state='error'` を記録
  - pty・renderer を一切ブロックしない（fire-and-forget、ADR-0004/TD-4 と同思想）
  - アプリ起動時に `archive_mirror` とスプールを突合し、未同期分を回収（クラッシュ復旧）
- `src/main/index.ts`: 組み立て。`archive_output_root` 未設定ならミラー系を一切起動しない

### Phase 3: IPC・設定 UI（renderer）

- `src/main/ipc/handlers.ts`: 出力先設定（ダイアログ `dialog.showOpenDialog` でフォルダ選択
  → プローブ検証 → 保存）、ミラー状態取得、バックフィル起動の各ハンドラ
- `src/renderer/src/components/`: 設定 UI に出力先表示・変更・解除、ミラー状態バッジ
  （同期済み/保留/エラー）、バックフィル実行ボタン（進捗と完了/失敗の明示）
- エラー時の見え方（usability rubric 対象）: ミラーエラーはステータスバーに非モーダル表示。
  claude の対話は継続できることを明記

### Phase 4: E2E・出荷時整合

- E2E（Playwright）: 出力先設定 → セッション実行 → ミラー先に transcript/metadata が現れる。
  出力先を書き込み不可にして → エラー表示 → スプールは無傷 → 復旧後に追い付く
- 出荷時（品質ゲート合格時）: spec §4.4.1 と実装の最終整合確認、本ファイル `status: shipped` 更新

## 5. 受け入れ基準

`acceptance.md`（同ディレクトリ）を参照。requirements-reviewer の逐条トレース対象。

## 6. リスク

- クラウド同期クライアントの挙動（部分同期・ロック・クォータ超過）は制御外。
  ミラーは結果整合であり、「クラウド側にいつ現れるか」は同期クライアント依存
- 同期フォルダへの高頻度追記は同期クライアントの帯域を消費する。デバウンスで緩和
- バックフィルは全アーカイブのフルコピーであり、大容量時は時間がかかる（進捗表示で対応）

## 7. スコープ外

- Google Drive API 直結アップロード（OAuth）— `ArchiveSink` 抽象で将来拡張可能にするに留める
- スプール側の容量管理・ローテーション（append-only 原則に抵触するため扱わない）
- SQLite DB の出力先変更（D-1）
