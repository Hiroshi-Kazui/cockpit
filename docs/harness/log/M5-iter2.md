# M5 — 反復2 記録（FIX：blocking＋major 解消、ゲート通過）

- 日付: 2026-07-20
- 実装: cockpit-implementer（FIX モード、反復1 の blocking 1＋major 1＋minor 3）
- 静的ゲート（オーケストレータ実測）: tsc.node=0 / tsc.web=0 / eslint=0 / vitest **349/349 pass** / E2E **4/4 pass**（フォーカストラップ・ショートカット無効化変更後も green） — green

## 変更ファイル
- `docs/technical-decisions.md` — TD-1 に「バージョン源についての注記」段落を追加。実測値 v2.1.205 は不変。v2.1.205=実行バイナリ実測／v2.1.215=statusline-cache.json payload の originating build、観測源が異なり片方が他方のアップ/ダウングレードを意味しない旨を明記（source-of-truth の不整合を上流で恒久解消）。
- `e2e/probes/td1-statusline-probe.js` — 起動バイナリの `--version` を `execFileSync` で取得し stdout/RESULT に自己記録（チャット送信ゼロ維持）。実測の正直性を独立検証可能に。
- `src/renderer/src/hooks/usePaneFocusShortcuts.ts` — 第3引数 `enabled`（既定 true）。false 中は capture-phase keydown を登録しない。deps に enabled を含み open/close で cleanup→再登録が正しく走る。
- `src/renderer/src/App.tsx` — `usePaneFocusShortcuts(..., !showSessionBrowser)`。閲覧中はグローバル Ctrl+1..4 無効化。
- `src/renderer/src/components/SessionBrowser.tsx` — `dialogRef` で Tab/Shift+Tab トラップ（focusable 都度収集・境界循環）、unmount 時フォーカス復元、一覧 `<ul>` に ArrowUp/Down フォーカス移動。
- `src/renderer/src/styles.css` — 検索入力背景 `black`→`var(--bg)`。

## 解消した指摘
- [blocking][requirements] TD-1 実測バージョン不整合 → 観測源注記で恒久解消（v2.1.205 維持）＋probe 自己記録。requirements 再レビューで解消確認。
- [major][usability] 閲覧モーダルのフォーカス封じ込め破れ（Ctrl+1..4/Tab がモーダル背後へ漏れ）→ enabled ゲート＋Tab トラップ＋フォーカス復元。usability 再レビューで解消確認。
- [minor] Escape 到達性（トラップで常時到達）／一覧の矢印キー移動／検索入力背景の theme 変数化 → いずれも解消。

## verdict 要約（反復2・全員 PASS）
| reviewer | status | score | blocking |
|---|---|---|---|
| code | PASS | 93 | 0 |
| architect | PASS | 94 | 0 |
| usability | PASS | 94 | 0 |
| requirements | PASS | 96 | 0 |

## ゲート判定: PASS（4体 PASS・全 score≥85・静的ゲート green）

### 残 minor（→ 反復3 で closable 分を収束）
- [code] `SessionBrowser.tsx:49` フォーカス復元が autoFocus 済み検索 input を捕捉し「呼び出し元ボタンへ復元」意図が未達（クラッシュ無し）
- [usability] `SessionBrowser.tsx:236` トランスクリプト（role="log"）が focusable でなくキーボードのみで長記録をスクロール不可（tabindex="0" 付与で改善）
- [architect] `SessionBrowser.tsx:142-159` 矢印/Tab トラップが hardcoded class セレクタ依存（roving-tabindex ref 化で DOM 走査依存を削減）

### 据え置き（非 closable・現状欠陥なし）
- [requirements minor] cache `"version"` 読取診断の自己記録（将来 statusLine 再検証時の運用改善提案。現状 defect でない）
- 反復1 据え置き分（symlink realpath 化、DTO 写像層、readFileSync ページング、pane narrowing、getSessionJsonlPath 三値契約）
