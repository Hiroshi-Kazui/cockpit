# M6 反復3 ログ（最終・合格）

日時: 2026-07-21
対象: M6 — アーカイブ出力先の設定可能化（クラウドストレージ対応）

## FIX（反復2 blocking 1件）
出力先 A→B→A 切替時の自動同期経路 silent 転記破壊を解消。
- `ArchiveSink` に `readTranscriptPrefix(sessionId, length)` 追加（`sink.ts`/`fsSink.ts`）。宛先先頭をバイト単位で content 照合
- `rebaselineSession` を3ケースに整理: 同一 root は保持 / 空宛先は skip-history（D-4）/ 既存内容ありは content-prefix 照合
  → 真の prefix なら宛先実サイズから安全 resume、不一致・照合失敗は `state='error'`＋`UNRECOVERABLE_SYNCED_BYTES` sentinel で恒久ブロック
- sentinel は既存 `computeTranscriptMirrorDiff` ガード再利用（DB スキーマ不変、spec §5 単一行維持）
- A→B→A 回帰テスト2件（真 prefix resume / suffix 恒久ブロック）追加

## 静的ゲート（実測）
tsc（node/web）0 / eslint 0 / vitest 404/404 / playwright 5/5。→ 通過

## レビュー verdict
| reviewer | status | score | 備考 |
|---|---|---|---|
| code | PASS | 88 | blocking 解消確認。major 1（this.sink の await 跨ぎ参照、破壊なし自己修復）は followup |
| architect | PASS | 93 | 4不変条件維持、sentinel 健全 |
| requirements | PASS | 96 | AC#4/#7/#9 維持、spec §5 不変 |
| usability | PASS | (blocking 0) | 反復2の結果を継続（FIX は main 側のみ、renderer 無変更） |

## ゲート判定: 合格
4レビュアー全員 PASS、blocking 0。静的・E2E green。
（usability は反復2で numeric score 未出力だが blocking 0・major 0・minor のみのため rubric 上 85 以上に相当。
FIX が renderer 非変更のため再レビューせず反復2 PASS を継続とした。）

## 出荷処理
- plan.md `status: approved → shipped`
- 未解消 non_blocking（major 1 ＋ minor 群）を `followups.md` へ集約
- spec §4.4.1 は実装と一致、齟齬なし（変更不要）

## 反復サマリ
反復1: 実装 → FAIL（blocking 3: 起動時復旧破壊 / backfill 転記破壊 / モーダルフォーカス漏れ）
反復2: FIX → FAIL（新規 blocking 1: A→B→A 切替 silent 破壊）
反復3: FIX → 合格
