# M10 反復2 — アーカイブ保存時の行選別

日付: 2026-07-27 / 判定: **FAIL**

## 静的ゲート（実測）
`tsc --noEmit`（node/web）exit 0 / `eslint --max-warnings=0` exit 0 / `vitest run` 534 passed（34 files、+12）

## verdict サマリ

| reviewer | status | score | 反復1 の指摘 |
|---|---|---|---|
| code | FAIL | 70 | 2件とも実機で解消確認 |
| architect | FAIL | 73 | B1 解消、B2 は方向は正しいが穴あり |
| usability | FAIL | 79 | 3件とも実データで解消確認 |
| requirements | FAIL | 80 | 3件とも解消確認、`queued_command` 訂正も充足 |

## 反復1 blocking の解消（4体が確認）
- **B1 解消**: `confirmedSourceOffset` を新設し完全行まで消化した位置のみ永続化、`parseBuffer` を `Buffer` 化。
  `confirmed + pending === 読み取り済み総バイト` の不変条件が代数的にも実測でも成立
- **B2 の元症状 解消**: `ArchiveAnchor`（`empty|uuid|noUuid`）導入、last-match 走査、
  指数拡大窓・チャンク走査でオフセット計算に off-by-one なし
- **B3 解消**: `queued_command` を denylist から削除。H: 実データ census で 45/45 行すべて保持

## 新規 blocking（修正で新設した分岐。4体全員が同一の2件を独立に実機再現）

**C1** `archiveRetention.ts:270-272` ＋ `archiver.ts:189-192, 243-251`。
`legacyArchiveSize` が「サイドカー無し ⇒ pre-M10 逐語アーカイブ」と**検証せずに断定**。
post-M10 の選別済みアーカイブでは等式が成立せず、**行の途中から**読み直す。
usability の実データ実測（H: の 27MB セッション）:
```
初回同期: source 27,314,036 → archive 2,355,500 (8.62%)
サイドカー削除 → 再アタッチ:
  archive 4,554,073        （+2,198,573B = 既存の 93% を無言で二重追記）
  onEntries 再発火 6,083 件（＝ トークン二重計上）
  onError 報告 0 件
```
破棄対象行の行中断片（`":"hook_success","payload":"xxx…"}}`）も R-5 に拾われて恒久混入。
到達経路: (a) 初回 append とサイドカー初回書き込みの間のクラッシュ、(b) H: ミラーからの復元
（`fsSink` はサイドカーをミラーしない）、(c) **アプリ自身のバナーが `archive-state.json` の削除を指示**。
`readSidecar` が「無し」と「不正 JSON」を両方 `null` に潰すため acceptance R-6 4分岐目にも違反。

**C2** `archiver.ts:339` vs `:93-99`。`state.lastUuid`（最後の保持行の uuid、無ければ null）と
`readArchiveAnchor`（`uuid` を持つ最後の行）の**非対称**。R-5 が保持を義務づける行（不正 JSON・
`uuid` なし未知 type）が末尾に来ると `scan` に落ちて毎回重複追記。クラッシュ不要の通常経路。

architect の診断: いずれも反復1 と同一の defect class（**型が契約を表現していない**）の再発。

## オーケストレータの対応
usability の実測により**起案時の削減率が誤りと判明**（287MB→11MB/3.8% と記載したが、保持行ごとの
envelope バイトをブロック単位集計から落としていた）。同じ H: コーパスでの実測値
**303.0MB → 29.8MB = 9.85%** に `plan.md` と `docs/adr/0011-archive-line-retention.md` を訂正。
