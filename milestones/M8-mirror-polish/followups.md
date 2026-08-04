# M8 残課題（followups）

ビルドループ終了時（2026-07-21、合格）に残った non_blocking。次回 `/cockpit-plan` が起案時に参照する。
すべて blocking ではない（合格を妨げない）。すべて minor。4レビュアー（code/architect/usability/requirements）の
指摘を集約・重複統合。

## minor（堅牢性・エッジケース）

- **[minor] destSize=0 の恒久 sentinel 化が一時的な宛先不在で過剰発火し得る** —
  `src/shared/mirrorPlan.ts:140`（`computeResumeVerificationRange`）／`src/main/archive/mirror/mirrorCoordinator.ts:304`。
  D-1 により destSize=0 かつ recordedSyncedBytes>0 は恒久 `UNRECOVERABLE_SYNCED_BYTES` sentinel（要手動再バックフィル）に
  分類されるが、これは「外部削除」だけでなく「宛先が一時的にアンマウント／未マウント」で `statTranscript` が
  null を返すケースも区別なく含む。D-1 の安全側方針（無音破壊ゼロ優先）としては意図通りだが、一時不在からの
  verify retry による自動回復を放棄する。将来 DriveApiSink 等で宛先の一時不在と外部削除を区別できるように
  なった時点で再訪する。
- **[minor] backfill 外側 catch の `recordError` 自体が例外を投げるとループ全体を中断し得る** —
  `src/main/archive/mirror/mirrorCoordinator.ts:417`。`recordError` は内部で `repo.get`/`upsert` を呼ぶため、
  元例外が repo/DB 破損由来だとこの診断記録自体が再 throw し、`failed++` に到達せず backfill ループ全体が
  中断し得る（従来は `failed++` のみで継続していた）。極端なエッジケースだが、`recordError` を try/catch で
  保護し失敗しても `failed++` と処理継続を保証すると堅牢。
- **[minor] sentinel 確定パスで verify retry を明示 clear していない** —
  `src/main/archive/mirror/mirrorCoordinator.ts:304`。sentinel/mismatch 確定時に
  `clearRetryState(sessionId, 'verify')` を呼んでいないため、残存 verify timer が後で再発火し得る
  （:242 の sentinel チェックで即 early-return するため実害はないが、無意味な再スケジュールが残る）。

## minor（テスト網羅）

- **[minor] verify/sync retry の非上書きを直接固定する専用テストが無い** —
  `src/main/archive/mirror/mirrorCoordinator.test.ts`。今回の複合キー化で verify と sync の retry timer が
  互いを上書きしなくなったことは構造上明らかだが、両者が同一 session で同時に in-flight でも独立して発火する
  ことを直接検証する回帰テストがない（現状は個別に :228 / :457 で単独検証のみ）。同様に、外側 catch
  `recordError` 経路（last_error 記録）を直接固定するテストも薄い。

## minor（UX 磨き込み）

- **[minor] バックフィル事前注記と継続注記の文言表現が揺れている** —
  `src/renderer/src/components/ArchiveOutputSettings.tsx:217`（「数分以上かかる場合があります」）と
  `:234`（「時間がかかる場合があります」）。時間的に排他的表示（実害なし）だが、同一表現に揃えると一貫性が増す。
- **[minor] フォーカスフォールバック先選定の意図コメントが薄い** —
  `src/renderer/src/App.tsx:84-88`。StatusBar 起点で ref 失効時にヘッダの「アーカイブ出力先」ボタンへ
  フォールバックする実装自体は妥当だが、「同一ダイアログを開く導線への着地」という選定意図を1行明示すると
  将来の読者に親切。
