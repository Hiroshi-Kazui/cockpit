# M13 iteration 1 — ペイン下部の口述入力欄

日付: 2026-08-26

## 実装

`cockpit-implementer`（sonnet）。変更・追加ファイル:

- `src/shared/dictation.ts`（新規、純関数 `resolveDictationKeyAction`）＋ `src/shared/dictation.test.ts`（13 tests）
- `src/renderer/src/hooks/usePtyPane.ts`（`sendText(text, submit)` を追加）
- `src/renderer/src/components/DictationInput.tsx`（新規）
- `src/renderer/src/components/Pane.tsx`（`.pane-terminal-wrap` の直後に無条件マウント）
- `src/renderer/src/styles.css`（`.pane-dictation`: `flex: 0 0 56px; height: 56px; overflow-y: auto; resize: none`）
- `e2e/dictation.spec.ts`（新規、3 tests）

## 静的ゲート（オーケストレータ実測）

| コマンド | 結果 |
|---|---|
| `npx tsc --noEmit` × node/web/e2e | 3構成すべて clean |
| `npx vitest run` | 46 files / 770 tests passed |
| `npx playwright test e2e/dictation.spec.ts e2e/terminal-repaint.spec.ts` | 7/7 passed |
| `npx eslint . --max-warnings=0` | 2 errors。ただし `EvaluationDashboard.tsx:59` / `useEvaluationForPurpose.ts:23` の**既存分**（`git status` で未変更、M13 のファイルは 0 件） |

### 途中で1度差し戻した実測差分

初回の実装報告は「dictation 3/3 が安定して green」だったが、こちらの実測では
`npx playwright test e2e/dictation.spec.ts e2e/terminal-repaint.spec.ts` の1回目で
`e2e/dictation.spec.ts:179`（`finally` の `fs.rmSync`）が
`EPERM, Permission denied: ...\Temp\cockpit-e2e-cwd-...` で赤になった。アサーションではなく teardown。
既存 `e2e/terminal-repaint.spec.ts:336` は同じ `rmSync` に `maxRetries: 10, retryDelay: 200` を付けており、
新規 spec だけがそれを落としていた。implementer に差し戻して同じオプションを付与 → 以降 green。

## レビュー verdict

| reviewer | status | score | blocking | non_blocking |
|---|---|---|---|---|
| code | PASS | 92 | 0 | major 2 / minor 4 |
| architect | PASS | 90 | 0 | major 2 / minor 4 |
| usability | PASS | 87 | 0 | major 3 / minor 6 |
| requirements | **FAIL** | 84 | **1** | major 1 / minor 3 |

### blocking（requirements）

- `acceptance.md` R-7 第1項「ペイン `n` の欄からの送信がペイン `n` の Terminal にのみ渡る」を固定する
  テストが存在しない。`src/renderer` に単体テストは0件（`vitest.config.ts` は `environment: 'node'` /
  `include: ['src/**/*.test.ts']`）、`e2e/dictation.spec.ts` も pane 0 のみを起動しているため、
  送信先の誤配線を検出する経路が皆無。挙動自体は `Pane.tsx:51,438` ＋ `usePtyPane.ts:220-226` の
  コード読解で正しいことを確認済み。
- オーケストレータの決定: **新しいテスト基盤（jsdom / testing-library）は導入しない**。既存 E2E fixture
  だけで「pane 1 から送って pane 0 には現れない」ケースを `e2e/dictation.spec.ts` に追加する。

### 4体が共通して挙げた major（non_blocking のため iteration では直さず followups へ）

- `sendText` が `void` 返しで `!running` / `term === null` のとき無言 no-op なのに、`DictationInput.tsx` が
  無条件に `setText('')` する。pty 終了直後の Enter で口述テキストが無表示のまま消える
  （ADR-0015 D-5「テキストを受け取って捨てるのは silent failure」の残りエッジ）。
  4体全員が「boolean 返しにして真のときだけクリア」を提案。

### レビュアーが実測で確認した「壊れていないこと」

- `Ctrl+1..4`（M5）は欄にフォーカスがあっても従来どおり動き、数字は欄に入らない（usability 実測）
- Enter 送信後もフォーカスは欄に残る（連続口述が成立、R-6）
- xterm の `paste()` は `focus()` を呼ばないため欄からフォーカスが飛ばない（同梱 dist 実装で確認）
- `.resize(` / `fit()` の全 call site は `usePtyPane.ts:130,142,192,193` と main 側受け口のみで、
  口述欄からは到達不能（requirements の全数確認）
- `attachCustomKeyEventHandler` / `onKey(` はリポジトリ全体で 0 件、`src/main/**` と
  `src/shared/ipc.ts` は無変更（新規 IPC チャネルなし）
- 帯の高さは 1 / 2分割 / 4分割すべてで 56px 固定

### 既存 E2E の既知失敗（M13 起因ではない）

requirements が全走した結果、`evaluation.spec.ts:184` と `git-sync.spec.ts:99` が失敗。
`milestones/M12-conpty-passthrough/followups.md:53-58` に同一箇所・同一症状で既存不具合として記録済み。

## 判定

**FAIL**（requirements の blocking 1件）→ iteration 2 へ。
