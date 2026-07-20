# M6 反復2 ログ

日時: 2026-07-20
対象: M6 — アーカイブ出力先の設定可能化（クラウドストレージ対応）

## FIX（反復1 blocking 3件）
- blocking 1（起動時リベースでクラッシュ復旧破壊）: `rebaselineSession` を同一 dest_root の既存行は保持して early-return に変更。復旧テストを実起動経路（setOutputRoot(persistedRoot)→recoverOnStartup）を通すものへ置換
- blocking 2（backfill が skip-rebaseline 済みを転記破壊）: `startBackfill` が `destSize>0 && recordedSyncedBytes>destSize` を検出しエラー化
- blocking 3（モーダル中のペインフォーカス奪取）: `App.tsx` enabled 条件に `!showArchiveOutputSettings` 追加

## 静的ゲート（実測）
tsc（node/web）0 / eslint 0 / vitest 401/401。→ 通過

## レビュー verdict
| reviewer | status | score |
|---|---|---|
| architect | PASS | 93 |
| usability | PASS | (blocking 0) |
| requirements | PASS | 94 |
| code | FAIL | 80 |

反復1 の blocking 3件はすべて解消確認（回帰テスト付き）。

## 新規 blocking（code 検出）
1. **[blocking] 出力先 A→B→A 切替で自動同期経路が silent 転記破壊** — `mirrorCoordinator.ts:157-178`（rebaselineSession）+ `:356-369`（syncTranscript）。
   単一行スキーマ（`archive_mirror` は session_id 主キー、`archiveMirrorRepo.ts:68` の ON CONFLICT(session_id)）のため、
   root 切替で行の dest_root が上書きされ、A へ戻った際に rebaselineSession が synced_bytes を spool サイズへ戻す一方、
   宛先 A ファイルは物理的に古い短いプレフィックスのまま。syncTranscript が synced_bytes 基準で読み宛先実サイズ位置へ追記するため、
   中間バイトが silent に欠落し `state='synced'` のまま。blocking 2 と同クラスだが backfill ガードの管轄外の自動同期経路。

## 判定: FAIL → 反復3（FIX）へ
方針: 単一行スキーマ（spec §5）を維持したまま append-only-safe にする最小修正（自動同期/rebaseline 経路にも
blocking 2 と同じ prefix/suffix 判定を適用。真の prefix への復帰は宛先実サイズから resume、復元不能な suffix は
state='error' 化）。per-(session_id, dest_root) 複合キー化は spec §5 のデータモデル変更を伴うためスコープ外（followup）。
