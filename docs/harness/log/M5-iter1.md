# M5 — 反復1 記録（実装＋4体レビュー：FAIL、FIX へ）

- 日付: 2026-07-20
- 実装: cockpit-implementer（IMPLEMENT M5）
- 静的ゲート（オーケストレータ実測）: tsc.node=0 / tsc.web=0 / eslint=0 / vitest **349/349 pass**（309→349、28 files）/ E2E（Playwright+Electron）**4/4 pass**（~8s） — green

## 実装の骨子
- 過去セッション閲覧: `sessionRepo.listSessions`（`SELECT ... FROM sessions ORDER BY started_at DESC`、SQLite index 由来）＋検索は parameter-bound `LIKE ? ESCAPE '\'`（`shared/sqlLike.ts` が `%`/`_`/`\` エスケープ）→ `archive/archiveReader.ts`（アーカイブルート配下への containment 済み FS 読み取り、main 限定）→ `archive/archiveBrowser.ts`（`ArchiveBrowserPort` 合成層、fake でテスト）→ `SessionBrowser.tsx`（read-only オーバーレイ、編集/削除導線ゼロ）。
- IPC は read-only 2 チャネル追加のみ（`cockpit:archive:listSessions`/`readSession`）。preload も 2 read メソッドのみ。append-only 不変条件維持。
- パース `shared/jsonl.ts::parseJsonlLineForDisplay`（純関数・寛容）。閲覧用に slash-command echo も表示（purpose 検出用 `readUserText` とは別・より寛容）。
- キーボード: `usePaneFocusShortcuts.ts` が Ctrl/Cmd+1..4 を capture phase で当該コードのみ奪取。通常キー・リサイズ・制御列は xterm へ素通し（spec §4.1 非破壊）。隠れペインの番号は no-op。
- レイアウト切替生存: PaneGrid は元々4ペイン常時マウント（CSS display 切替のみ）。SessionBrowser は PaneGrid の兄弟オーバーレイ。E2E で「開始→3レイアウト巡回→2通目送信で pty 生存実証」。
- E2E: `e2e/` 一式（`@playwright/test`＋`_electron.launch`）。fake claude は外部バイナリのみ差し替え（`app_settings.claude_path` 経由）、app 本体はテスト専用経路なしで production コードを丸ごと通す。
- TD-1 実 pty 実測（M4 持ち越し）: `e2e/probes/td1-statusline-probe.js`（opt-in・チャット送信ゼロ）で実 claude を起動。信頼済みフォルダは初回描画で statusLine 発火＝主信号前提を確認、未信頼フォルダは trust gate 通過後に発火（700ms/10s フォールバックがカバー）。結果を TD-1 に記録。

## verdict 要約
| reviewer | status | score | blocking |
|---|---|---|---|
| code | PASS | 93 | 0 |
| architect | PASS | 93 | 0 |
| usability | PASS | 88 | 0（closable major 1） |
| requirements | **FAIL** | 84 | **1** |

## ゲート判定: FAIL（requirements blocking＋score 84<85）

### FIX へ集約した課題
1. **[BLOCKING][requirements] TD-1 実測記録のバージョン不整合**: `technical-decisions.md:18` が v2.1.205、前日 2026-07-19 の repo 内記録（`statusline.ts:7`/`jsonl.ts:7,15`/`purposeDetection.ts:9`/`M3-iter3.md:20`）は v2.1.215。probe がバージョンを出力せず裏付け不能。
   - **オーケストレータ実測で真相確定**: 実行バイナリ `claude --version`=**2.1.205**（TD-1 の値は正しい）／`statusline-cache.json` の `"version"`=**2.1.215**（前日 payload の originating build）。**2つの異なる実データ源が別々の値を報告しているだけで両方正直**。ダウングレードではない。TD-1 に観測源の違いを明記して恒久解消する方針（v2.1.205 は維持）。
2. **[major][usability] 閲覧モーダルのフォーカス封じ込め破れ**: `aria-modal` 宣言に反し、Tab とグローバル Ctrl+1..4 がモーダル背後の xterm へフォーカスを飛ばす。→ 閲覧中は `usePaneFocusShortcuts` 無効化＋ダイアログ内 Tab トラップ（Escape 逃げも同時解消）。
3. **[minor] probe のバージョン自己記録**（#1 の恒久裏付け）、**[minor] 一覧の矢印キー移動**、**[minor] 検索入力背景の theme 変数化**。

### 据え置き（非 closable・現状欠陥なし、churn 回避のため FIX 対象外）
- [code minor] `resolveContainedPath` の symlink realpath 化（renderer は path を渡さず app-written のみ・悪用面なし）
- [code/architect minor] `pane as PaneIndex` narrowing、`listSessions` の DTO 写像層、transcript の readFileSync 全読み（ページング）、`getSessionJsonlPath` 三値契約

## 次アクション: 反復2（FIX モード）
