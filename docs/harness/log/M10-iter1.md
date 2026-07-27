# M10 反復1 — アーカイブ保存時の行選別

日付: 2026-07-27 / 判定: **FAIL**

## 静的ゲート（実測）
`tsc --noEmit`（node/web）exit 0 / `eslint` exit 0 / `vitest run` 522 passed（34 files）

## verdict サマリ

| reviewer | status | score |
|---|---|---|
| code | FAIL | 60 |
| architect | FAIL | 70 |
| usability | FAIL | 61 |
| requirements | FAIL | 76 |

## 変更ファイル
- `src/shared/archiveRetention.ts`（新規・純関数）
- `src/shared/archiveRetention.test.ts`（新規・75 tests）
- `src/main/archive/archiver.ts`
- `src/main/archive/archiver.test.ts`

## blocking（集約後 3 件 ＋ ゲート 1 件）

**B1（4体全員・3体が実機再現）** `archiver.ts:206-220`。未完結行を `parseBuffer` に持ち越したまま
`sourceOffset` / サイドカーを `stat.size` まで進めるため、再アタッチ後に行の前半が永久消失し、
後半が不正 JSON として R-5 に拾われて append-only アーカイブに壊れた断片が残る（`onError` なし）。
`buffer.toString('utf-8')` のチャンク境界 U+FFFD 置換も併発。M10 が新設した退行。

**B2（3体・3体が実機再現）** `archiveRetention.ts:225-228` ＋ `archiver.ts:49-59`。
`archiveLastUuid === null` を一律 `{kind:'zero'}` にするため、末尾行が `uuid` を持たないアーカイブで
ソースを 0 から読み直し**全量重複追記**。usability の実データ検証で
**70 セッション中 69 のソース末尾行が `uuid` 無し**＝ほぼ全件で発生。

**B3（usability・オーケストレータが H: 実データで再検証）** `archiveRetention.ts:33`。
`attachment.type: "queued_command"` の破棄で人間の割り込み発話が消える。
H: 実測 45 行中 26 行が `origin.kind:"human"`、うち `type:"user"` 行に同一本文があるのは 2 行のみ
＝約 24 件がこの行だけの記録（「ながい。３行が原則だ」「いい加減手を止めよ！！！」等、
軌道修正の瞬間という解析価値が最も高い発話）。**起案側の誤り**。

**ゲート（requirements）** `playwright test` 2 failed。原因は M10 ではなくコミット済みの
xterm CanvasAddon 化（`usePtyPane.ts:74`）。オーケストレータは waive せずユーザーへエスカレーションする方針。

## オーケストレータの対応
B3 を受けて `plan.md` R-2/R-3、`acceptance.md` R-2/R-3、`docs/adr/0011-archive-line-retention.md`
（D-3a 追加）を訂正。`queued_command` を保持側へ移した。
