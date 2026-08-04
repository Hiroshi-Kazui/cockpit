# M10 反復3 — アーカイブ保存時の行選別

日付: 2026-07-27 / 判定: **4レビュアー全員 PASS**（E2E ゲートのみユーザー判断待ち）

## 静的ゲート（実測）
`tsc --noEmit`（node/web）exit 0 / `eslint --max-warnings=0` exit 0 / `vitest run` **546 passed**（34 files、+12）
`playwright test` **2 failed / 4 passed** — M10 起因ではない（下記）

## verdict サマリ

| reviewer | status | score |
|---|---|---|
| code | **PASS** | 92 |
| architect | **PASS** | 88 |
| usability | **PASS** | 88 |
| requirements | **PASS** | 86 |

rubric ゲート 1（tsc/eslint 0）・3（4体 PASS）・4（全員 score ≥ 85）を充足。
ゲート 2 は unit green、E2E は下記の既存原因で red。

## 変更ファイル（M10 の差分）
- `src/shared/archiveRetention.ts`（新規）
- `src/shared/archiveRetention.test.ts`（新規・82 tests）
- `src/main/archive/archiver.ts`
- `src/main/archive/archiver.test.ts`（22 tests）

`src/main/archive/mirror/**` は無変更（4体が独立に検証）。ADR-0008 / ADR-0009 は無改訂で成立（D-1）。

## 反復2 blocking の解消（4体が独立に実機/実データで確認）

**C1 解消**: `legacyArchiveSize` を `ResumeDecision` から完全削除。「サイドカー無し ＋ 錨 uuid」は
常に `scan` に落ちる。`readSidecar` を `{kind:'absent'|'invalid'|'present'}` 型化（`invalid` は
`onError` で必ず表出）。さらに `attach()` に構造的ガード `isSourceOffsetAtLineBoundary` を新設。

usability の実データ全数検証（H: の 28 セッション、サイドカー削除後の再アタッチ）:

| 指標 | 反復2 | 反復3 |
|---|---|---|
| アーカイブ増分 | +2,198,573B | **0B（28/28）**、27MB 例は sha256 一致 |
| `onEntries` 再発火 | 6,083 行 | **52 行**（すべて破棄型。`usage` 0 件 / `userText` 0 件） |
| 再追記された保持行 | 6,083 | **0** |

→ トークン二重計上・目的自動検出の再発火はいずれも起きない。
pre-M10 逐語アーカイブ 10 セッションからの移行も既存プレフィクス不変・追記 0B。
`isSourceOffsetAtLineBoundary` の偽陽性は 56 回の attach 判定で **0 件**。

**C2 解消**: `lastRetainedUuid(retainedLines, fallback)` で `state.lastUuid` の意味論を
`readArchiveAnchor` に揃えた。architect が懸念した「fallback の初期値」は健全に閉じている
（attach 時の `lastUuid` は常にアーカイブ自身の後方走査から再導出される）。3連続再アタッチで重複 0。

**C3 解消**: `reportUnsafe` で日本語・絶対パス無しの文言に。`archive-state.json` /
`transcript.jsonl` の削除指示を撤去（C1 の引き金だった）。診断は `Error` の `cause` 経由のみ。

## 削減率（実測・2体が独立に計測）
- usability: H: コーパス 29 ファイル **303.0MB → 29.8MB = 9.85%**（plan.md 訂正値と完全一致）
- requirements: `~/.claude/projects` 581 ファイル 2,129.7MB → 197.2MB = **9.26%**
- セッション単位のばらつき 5.94〜37.5%（thinking/image 偏重セッションは 3〜4 倍残る）

## 人間発話の保全（usability が全量確認）
`userText` を持つ人間発話 533 件のうち破棄 **0 件**。`queued_command` 45 件のうち破棄 0 件。
`image,text` 36 行すべて保持。`tool_result` に人間の自由記述は `~/.claude/projects` 2.2GB 全量で 0 件
（"the user said:" を含む 44 件はすべて CLI 定型文）。

## requirements の新規発見（ADR の前提が実測で反証）
`~/.claude/projects` 581 ファイルに**保持されるが `uuid` を持たない行が 1,349 行実在**
（`agent-name` 1,332 / `frame-link` 10 / `custom-title` 7。denylist 未収載なので D-3 により保持）。
ADR-0011 D-4 の起案時前提「`uuid` を持たない行は全て破棄対象」を否定する。
帰結は `scan` 経路での 1 回限りの重複追記（該当は 581 中 1 ファイル ≒ 0.17%、次回以降収束、
取りこぼし・append-only 違反なし）。**ADR を訂正済み**。解消は followups。

## E2E ゲート（M10 起因ではない）
`e2e/app.spec.ts:182` と `e2e/archive-output.spec.ts:129` が `.pane-terminal` の `textContent` 空で失敗。
原因は**コミット済みの xterm CanvasAddon 化**（`src/renderer/src/hooks/usePtyPane.ts:74`、
working tree 未変更。コミット e0780da / fb4c253 / 149a0e7 系）。canvas レンダラは DOM に
テキストを置かないため DOM ベースの assert が通らない。
**帰結として `app.spec.ts:187-207` のアーカイブ内容 assert に到達せず、M10 の選別・再開経路は
E2E で一切検証されていない。** rubric ゲート 2 を勝手に waive せずユーザーへエスカレーションした。

## オーケストレータの文書訂正（反復3）
- `docs/adr/0011-archive-line-retention.md`: D-4 を実装の確定内容へ改訂
  （錨の定義、サイドカー不在は無条件 `scan`、行境界ガード、確定オフセット、`uuid` 無し保持行の実在）。
  **D-4a を新設**（`unsafe` = 一次記録の watch 停止。ADR-0009 の派生物停止との非対称と
  spec §4.4「記録の完全性」に対するトレードオフを明示）
- `milestones/M10-archive-line-retention/plan.md` §7: `archive-state.json` の spec 反映 2 項目と
  `uuid` 無し保持行のリスクを追加
- `milestones/M10-archive-line-retention/acceptance.md`: R-5 の「空行」記述の事実誤認を訂正、
  R-6 を `archiveAnchor` ベースへ更新し行境界ガード・確定オフセットの条項を追加
