# M13 受け入れ基準 — ペイン下部の口述入力欄

requirements-reviewer の逐条トレース基準であり、implementer の実装スコープ定義。
各項目は「どのファイル/関数が満たすか」を特定できなければ未達扱い。
共通ゲート: `tsc --noEmit`（node/web）/ `eslint` / `vitest run` / `playwright test` が green。
出典は `milestones/M13-dictation-input/plan.md`（R-1〜R-9）と `docs/adr/0015-pane-dictation-input.md`（D-1〜D-7）。

## R-1: 常設の入力欄

- [ ] `src/renderer/src/components/Pane.tsx` に、端末（`.pane-terminal-wrap`）の下に置かれる入力欄が
      ある。pty の起動状態・レイアウト・情報行の有無で **DOM から消えない**（条件付きレンダリングを
      使っていないことがコードで確認できる）
- [ ] `src/renderer/src/styles.css` で欄の高さが定数（`flex: 0 0 <n>px` + `height`）。内容が増えても
      伸びず内部でスクロールする（`.pane-info` と同じ作り）
- [ ] 4分割レイアウトの各ペインにそれぞれ欄がある（ペイン固有。共有の1つではない）

## R-2: 端末をリサイズしない

- [ ] 欄の内容変更・フォーカス・disabled 切替のいずれからも `pty.resize` / `fitAddon.fit()` が
      呼ばれる経路が存在しない（grep で確認可能）
- [ ] `e2e/terminal-repaint.spec.ts` の4テストが green（欄の追加で行の不変条件が壊れていない）

## R-3: 送信経路（ADR-0015 D-1）

- [ ] 送信は `Terminal.paste(text)` → `Terminal.input('\r')` の順で行う
      （`src/renderer/src/hooks/usePtyPane.ts` に追加する `sendText` 相当）
- [ ] `ESC[200~` / `ESC[201~` を cockpit のコードが自分で組み立てている箇所が**無い**
      （bracketed paste の判定は xterm.js に委譲。grep で確認）
- [ ] `src/shared/ipc.ts` の IPC チャネル一覧に新規チャネルが増えていない
- [ ] 口述欄から `window.cockpit.pty.write` を直接呼ぶ経路が無い（すべて Terminal 経由 →
      既存の `term.onData` ハンドラを通る）

## R-4: 改行の扱い（D-2）

- [ ] 送信テキストが `normalizeInitialPromptText`（`src/shared/prompt.ts`）を通る
- [ ] 欄に `a\nb` が入っている状態の Enter で、pty に渡る文字列が `a b` である（unit テスト）

## R-5: キー割り当て

- [ ] Enter: 送信（`paste` + `input('\r')`）
- [ ] Shift+Enter: 欄内に改行が入り、`paste` / `input` が呼ばれない
- [ ] Ctrl+Enter: `paste` のみ呼ばれ、`input('\r')` が呼ばれない
- [ ] Escape: そのペインの端末へフォーカスが移る（`usePtyPane` の `focus` を使う）
- [ ] **IME 変換中の Enter（`isComposing === true`）では送信しない**（unit テスト）
- [ ] `Ctrl+1..4` の既存挙動が変わらない（`usePaneFocusShortcuts` に変更が無い、または
      変更しても `e2e/app.spec.ts` の該当テストが green）

## R-6: 送信後の状態

- [ ] 送信成功後、欄の値が空になる
- [ ] 送信後もフォーカスが欄に残る（連続口述ができる）
- [ ] 空文字・空白のみの Enter で `paste` / `input` が一度も呼ばれない（unit テスト）

## R-7: 送信先の限定と未起動時（D-4/D-5）

- [ ] ペイン `n` の欄からの送信が、ペイン `n` の Terminal にのみ渡る（unit テスト。
      他ペインの `paste` が呼ばれないことを固定）
- [ ] `running === false` の間、欄が `disabled` で、理由が分かるプレースホルダ（例「セッション開始後に
      使えます」）が出る
- [ ] `running === false` のときに送信を試みても何も送られない（`sendText` 側でも防ぐ。
      UI の disabled だけに頼らない）

## R-8: 素通し原則（D-7 / spec §4.1）

- [ ] `usePtyPane.ts` の `term.onData` ハンドラ・`onResize` ハンドラ・`windowsPty` 設定・
      CanvasAddon の初期化順に変更が無い（差分で確認）
- [ ] xterm.js に `attachCustomKeyEventHandler` を足していない
- [ ] pty 出力（`pty.onData`）を解釈・加工する経路を追加していない
- [ ] `src/main/**` に変更が無い、または変更が口述欄と無関係であることが説明できる

## R-9: 純関数の test-first（CLAUDE.md）

- [ ] 送信可否とペイロードを決める純関数が `src/shared/` にあり、副作用（Terminal / IPC）を持たない
- [ ] その純関数の unit テストが実装より先に書かれ、red を確認してから green にした記録が
      ビルドログに残る
- [ ] テストが次を網羅する: 空文字 / 空白のみ / 通常テキスト / 内部改行あり / Ctrl+Enter /
      Shift+Enter / IME 変換中

## R-10: アクセシビリティ

- [ ] 欄に `aria-label`（例「口述入力（Enter で claude へ送信）」）がある
- [ ] キーボードのみで欄に到達でき、Escape で端末へ戻れる
- [ ] disabled 状態が支援技術から判別できる（`disabled` 属性そのもの、または `aria-disabled`）

## E2E

- [ ] 欄に文字を入力して Enter → fake-claude が1行のユーザー発言として受け取り、アーカイブされた
      transcript にその文言が現れる（既存 `e2e/app.spec.ts:173-210` の対応物）
- [ ] レイアウト切替（1 → 4分割 → 1）を挟んでも欄が消えず、切替後も送信できる
- [ ] セッション未開始のペインで欄が `disabled` である
- [ ] Ctrl+Enter で送った場合、transcript にユーザー発言が現れない（CR を送っていないので claude が
      確定していない）ことを確認できる（fake-claude は行単位で受けるため、CR が無ければ turn にならない）

## 既存機能の回帰

- [ ] `e2e/app.spec.ts` / `archive-output.spec.ts` / `evaluation.spec.ts` / `git-sync.spec.ts` /
      `terminal-repaint.spec.ts` / `migration-archive-mirror.spec.ts` が green
- [ ] 目的入力ダイアログ（`PurposeDialog`）の Ctrl+Enter 確定・Escape キャンセル・Tab トラップが不変
- [ ] `usePtyPane` の既存挙動（起動・resize・exit 通知 `[claude exited: code=…]`・focus）が不変
