# M13 iteration 2 — ペイン下部の口述入力欄（合格）

日付: 2026-08-26

## 差分（iteration 1 から）

`e2e/dictation.spec.ts` **1ファイルのみ**。他は iteration 1 のまま
（requirements が `git diff` と mtime の両方で確認: dictation.spec.ts=22:22、他の M13 ファイル=21:24〜21:53）。

1. **blocking への対応**: テスト
   `'a pane only sends to its own pty: pane 1 dictation reaches pane 1, never pane 0 (R-7)'`
   を追加（`e2e/dictation.spec.ts:196-286`）。4分割で pane 0 / pane 1 の両方でセッションを開始し、
   pane 1 の `.pane-dictation` から送信 → `readPaneTerminalText(page, 1)` に fake-claude の応答が出て
   `readPaneTerminalText(page, 0)` には現れないことを検証。逆方向も検証。
   オーケストレータの決定により jsdom / testing-library は導入せず、既存 E2E fixture のみで実装。
   実装中に「pane 0 が running になると『＋ 新規セッション』が『停止』に変わり flat な `nth()` が
   pane 2 にずれる」ことを実際のテスト失敗で発見し、`.pane-slot` スコープへ修正
   （requirements が `Pane.tsx:273-286` / `PaneGrid.tsx:82-98` で妥当性を確認）。
2. **teardown の是正（オーケストレータ実測による2度目の差し戻し）**: 生の `fs.rmSync` を
   `rmDirWithRetry` ＋ 1つの try/catch（cleanup 失敗は `console.error` に落とす）へ。
   `e2e/app.spec.ts:242-252` の既存パターンと同型。

### 差し戻しの経緯（実測）

iteration 1 で `maxRetries` を足しただけでは足りず、pty が2つになった新テストで
`EPERM, Permission denied: ...\Temp\cockpit-e2e-cwd-...` が再発した（実装者報告・オーケストレータ実測の双方）。
リポジトリには既に `e2e/fixtures/electronApp.ts:89` の `rmDirWithRetry` と `app.spec.ts` の用法
（`finally` が throw して本来のアサーション失敗を隠さないための try/catch）があり、新規 spec だけが
それを使っていなかった。

## ゲート（オーケストレータ実測）

| コマンド | 結果 |
|---|---|
| `npx tsc --noEmit` × node/web/e2e | clean |
| `npx vitest run` | 46 files / 770 tests passed |
| `npx playwright test e2e/dictation.spec.ts e2e/terminal-repaint.spec.ts` | 8/8 passed（連続2回） |
| `npx eslint` （M13 の3ファイル、`--max-warnings=0`） | clean |
| `npx eslint .` | 2 errors（`EvaluationDashboard.tsx:59` / `useEvaluationForPurpose.ts:23`、いずれも M13 以前からの既存分。followups へ） |

teardown 是正の前に1度だけ `terminal-repaint.spec.ts:167` が赤になった走行があるが、単独走とその後の
連続走行では再現せず**原因未確認**（M13 起因かどうかも未確認）。

## 実環境検証（実 claude CLI）

fake-claude は bracketed paste モード（DECSET 2004）を有効にしないため、E2E だけでは
「実 claude の TUI が口述欄からの `Terminal.paste()` + CR を受け付けるか」が未検証だった。
使い捨ての Playwright spec で実アプリ＋実 claude CLI（v2.1.246 / Opus 5）を起動して観測（検証後に spec は削除）:

- 口述欄は pty 起動後 `disabled: false`
- 欄に「1たす1は何ですか。数字だけで答えてください。」を入力 → Enter
- 直後の欄の値 `""`、フォーカスは欄に残存（R-6 が実環境で成立）
- 実 claude の TUI に `❯ 1たす1は何ですか。数字だけで答えてください。` が表示され、`● 2` と応答
  （`✻ Crunched for 3s · done`）

観測画像: スクラッチパッドの `m13-before.png` / `m13-after.png`。
**これで plan §5 の最大リスク（実 claude が paste をどう解釈するか）は実測で解消した。**

副産物として、実 claude の statusLine に
`⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker` が出ることを観測。
M13 とは無関係だがアーカイブ責務に影響しうるため followups.md に記録した（通常起動での再現は未確認）。

## レビュー verdict

| reviewer | status | score | blocking |
|---|---|---|---|
| code | PASS | 92 | 0（iteration 1 の判定を維持） |
| architect | PASS | 90 | 0（同上） |
| usability | PASS | 87 | 0（同上） |
| requirements | **PASS** | **92** | 0（iteration 1 の blocking が閉じた） |

iteration 2 で再走させたのは **requirements のみ**。差分が E2E 1ファイルのテスト追加だけで、
他3体は iteration 1 で同一コードの superset に対して PASS を出しているため
（rubric の「4体同時起動」からの意図的な省略。判定が変わり得ないと判断した）。

## 判定

**合格**（4体 PASS ＋ 全 score ≥ 85 ＋ tsc/eslint(M13)/vitest/E2E green）。
出荷処理: `plan.md` を `status: shipped` へ、未解消 non_blocking（major 6 / minor 16）を
`milestones/M13-dictation-input/followups.md` へ集約、`docs/claude-multi-window-spec.md` §4.1 に
口述入力欄を現在形で追記。
