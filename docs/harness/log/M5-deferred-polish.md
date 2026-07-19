# M5 収束後 — 据え置き項目のユーザー要求対応（追加磨き込み）

- 日付: 2026-07-20
- 契機: ユーザー質問「1-8のうち解決しておいたほうが良い課題は？」→「4,5も対応してほしいのだが、本当に複雑化するのか？」。M5 は既に4体 PASS で課題ゼロ収束済み（M5-iter1〜4）だが、レビュアーが「非 closable / 対応不要」とした据え置き non-blocking を、ユーザー指示で追加対応した記録。
- 前提の訂正: 私は当初「2-5 を直すと複雑化する」と述べたが、複雑化リスクは 1番（callback ref churn）だけに該当し、2-5 に広げたのは誤り。訂正の上で 2・3・4・5 を対応（1番はレビュアー2名の「対応不要」明言どおり据え置き継続）。

## フェーズA: 据え置き4件の対応（実装＋4体レビュー）
静的ゲート（オーケストレータ実測）: tsc.node=0 / tsc.web=0 / eslint=0 / vitest **353/353**（349→353）/ E2E **4/4** — green

### 対応内容
- **[code] symlink 対応の containment 再確認**（`archiveReader.ts`）: 読み取り直前に injectable `realpath` で実体解決し archive ルート配下か再確認（2層防御）。realpath 例外は `ArchiveTranscriptReadError` へマップ（握り潰さない）。`shared/paths.ts` の純関数は不変（FS 依存を shared に持ち込まない）。
- **[code/architect] 長大 transcript の一気読み対策**: 同期 readFileSync→`fs.promises` 非同期化、`MAX_DISPLAY_TURNS=500`（最新側を残す）、`ArchiveReadSessionResult` に `truncated`/`omittedCount` を型付き追加、`SessionBrowser` が `role="status"` バナーで「古い N 件を省略」を明示（silent truncation 禁止）。**アーカイブ本体は不変・表示のみ省略**。
- **[code/architect] 型整理3点**: `pane as PaneIndex`→`toPaneIndex` ランタイムガード、`listSessions` は中立 `SessionListRow[]` を返し row→DTO 写像を合成層 `archiveBrowser` へ移動（反復1 指摘の層責務改善）、`getSessionJsonlPath` の三値を `SessionJsonlLookup` 判別ユニオンへ。
- **[requirements] probe の cache バージョン自己記録**: `td1-statusline-probe.js` が `statusline-cache.json` の version も read-only 併記。実行バイナリ版（反復2で実装）と併せ**両バージョン源が機械的に裏付け可能**に。

### verdict（フェーズA・全員 PASS）
| reviewer | status | score |
|---|---|---|
| code | PASS | 93 |
| architect | PASS | 94 |
| usability | PASS | 92 |
| requirements | PASS | 96 |

要件面: 表示上限はメモリ内 slice の読み取り経路限定で JSONL 実体・sessions・メタデータへの書き込み皆無 → spec §4.4 の append-only/完全性を保持（requirements が逐条確認）。

## フェーズB: フェーズA が生んだ/露出させた終端 minor 5件のクリーンアップ
静的ゲート（オーケストレータ実測）: tsc.node=0 / tsc.web=0 / eslint=0 / vitest **353/353** / E2E **4/4** — green

### 対応内容（doc・コメント・1行のみ、新ロジックなし）
1. [code] `shared/ipc.ts` の `toPaneIndex` doc コメントの call site 列挙を実態に訂正（撤去済み sessionRepo を除き、archiveBrowser/purposeRepo/sessionCoordinator に更新）。
2. [code/architect] `purposeRepo.ts:22` の唯一の取り残し `as PaneIndex` を `toPaneIndex(row.pane)` に統一（silent-failure 禁止原則の統一）。→ grep で `toPaneIndex` call site が archiveBrowser:59 / purposeRepo:22 / sessionCoordinator:295,304 の4箇所のみ・sessionRepo に無しを確認。
3. [code/usability] `SessionBrowser.tsx` のセッション切替時に前本文が「読み込み中…」下に残る問題 → ロード開始時に `turns` を即 null クリア。
4. [architect] `archiveReader.ts` の `MAX_DISPLAY_TURNS` コメントを正確化（read/parse は O(file) のまま、有界化されるのは返却配列/DOM。ストリーミングは M5 では YAGNI）。
5. [requirements] `technical-decisions.md`（TD-6）に「表示上限は閲覧 UI の省略のみ・アーカイブ本体は spec §4.4 のとおり完全/不変・省略は truncated/omittedCount で明示」を追記。

### 収束判定（フェーズB）
フェーズB の5件は直前レビュー（code/architect）が名指しした指摘の逐語的実装で、doc・コメント・1行キャスト・1行 state リセットのみ＝**新ロジックを産まない終端修正**。オーケストレータが (a) 静的ゲート全 green、(b) grep で #1/#2 の call site 一致を独立検証。doc/1行変更に対し更なる4体レビューは過剰（新たな cosmetic nit を無限生成する方向）と判断し、実測検証をもって収束とした。この判断根拠を本ログに明示的に記録。

## 最終状態
- **M5 は課題ゼロ収束済み（M5-iter1〜4）＋据え置き項目もユーザー要求で追加対応完了**。closable-worthwhile な残課題ゼロ。
- 残る据え置き（現状欠陥なし・正直に開示）: インライン callback ref churn（レビュアー2名「対応不要」明言）、環境制約（better-sqlite3 の vitest 直ロード不可→fake+E2E で担保、TD-1 probe は安全上 opt-in、renderer 単体テスト基盤なし→型+E2E で担保）。
- cockpit 全マイルストーン M1〜M5 完了。
