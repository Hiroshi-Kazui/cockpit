# M13 残課題（followups）

ビルドループ終了時（2026-08-26、iteration 2 で合格）に未解消だった `non_blocking` の集約。
4レビュアーの verdict から重複を統合し severity 順に並べたもの。**この場では修正していない**。
次回以降の `/cockpit-plan` が取り込みを判断する。

## major

1. **`sendText` が送信できなくても欄をクリアする（4レビュアー全員が指摘）**
   `src/renderer/src/components/DictationInput.tsx:42-48` / `src/renderer/src/hooks/usePtyPane.ts:220-226`
   `sendText` は `!runningRef.current` または `termRef.current === null` で無言 no-op する一方、呼び出し側は
   `submit` / `insert` 双方で無条件に `setText('')` する。pty 終了直後の Enter で口述テキストが痕跡なく
   消える。ADR-0015 D-5「テキストを受け取って捨てるのは silent failure」の残りエッジ。
   提案: `sendText` を `boolean`（または Result）返しにし、true のときだけ欄をクリアする。false では
   値を残し、必要なら理由を表示する。**4体全員が同一の修正案を挙げており、次に着手する最有力候補**。

2. **定数高の不変条件（ADR-0015 D-3）を守るテストが無い（architect）**
   `e2e/dictation.spec.ts` は「欄が4つある」「レイアウト切替で消えない」まで。将来 `height: auto` /
   `field-sizing: content` / 自動伸長を入れても全テストが green のまま通り、1a78edb で根絶した表示崩れが
   戻る。現状の防御は CSS とコメントのみ。
   提案: 実行中ペインで `readPaneTerminalGrid(page, 0)` を取り、欄に10行分のテキストを `fill` した後で
   再取得して `toEqual` を固定する（既存 fixture のみで書ける）。

3. **キー割り当てが画面のどこからも分からない（usability）**
   `src/renderer/src/components/DictationInput.tsx:65,70`
   プレースホルダは「口述入力（Enter で送信）」のみで1文字入れると消える。Shift+Enter / Ctrl+Enter /
   Escape は `aria-label` にだけ存在し視覚ユーザーに届かない。同アプリの `PurposeDialog.tsx:79` は
   `.dialog-body__hint` で常時提示しており、その先例に揃っていない。
   提案: `title` 属性か帯内の1行ヒントで D-6 の表を常時提示する。

4. **Ctrl+Enter の意味が `PurposeDialog` と反転している（usability）**
   `src/shared/dictation.ts:55-58` vs `src/renderer/src/components/PurposeDialog.tsx:43`
   目的入力ダイアログは Enter=改行 / Ctrl+Enter=送信、口述欄は Enter=送信 / Ctrl+Enter=送信しない。
   同じセッション開始フロー内で同じ和音が正反対を意味し、凡例（上記3）が無いため「Ctrl+Enter で
   送ったつもりが送られていない」が起きる。ADR-0015 D-6 の決定自体は妥当。
   提案: 凡例の常時表示＋insert 実行時のフィードバック（「claude の入力欄に挿入しました（Enter で送信）」）。

5. **`.pane-dictation` の 56px が4分割で端末を3行削り、小窓で端末を潰す（usability major / code minor）**
   `src/renderer/src/styles.css:488-490`
   実測（viewport 1386x837）: 1画面 39→43 rows、4分割 15→18 rows（帯を `display:none` にした場合との比較）。
   さらに4分割で縮めると帯は 56px を譲らず `.pane-terminal-wrap` だけが吸収し、900x600 で端末 5 rows、
   800x480 で 1 row、700x400 で 0px。常設欄というトレードオフはユーザー合意済みだが、56px は
   12px Consolas で3行分あり口述1〜2文には過剰。
   提案: `.pane-info` 級（約40px）へ下げる。併せてペインが潰れる下限（`.pane-slot` の min-height か
   `BrowserWindow` の minHeight。`src/main/index.ts:121-123` に最小サイズ指定なし）を検討。

6. **renderer 側の単体テスト基盤が無い（code）**
   `vitest.config.ts` は `environment: 'node'` / `include: ['src/**/*.test.ts']` で、`src/renderer` の
   テストは0件。M13 のペイン束縛は E2E（`e2e/dictation.spec.ts:196-286`）で観測可能な帰結として
   固定したが、`paste` の呼び出し自体をスパイする層は無い。
   提案: jsdom + testing-library の導入是非を単独マイルストーンで判断する（M13 では意図的に見送った）。

## minor

- `src/renderer/src/hooks/usePtyPane.ts:220` — `sendText(text, true)` の boolean フラグ引数で意味が
  型から読めない。`DictationKeyAction.kind`（'submit' | 'insert'）→ boolean の写像を
  `DictationInput.tsx:39-49` の switch で開き直している。提案: `sendText(text, { submit })` か
  kind をそのまま受ける形にして写像を消す（architect）
- `src/shared/dictation.ts:55` — `metaKey` 分岐（＋専用テスト1本）は Windows 固定の本アプリと
  D-6（Ctrl+Enter のみ）の範囲外で YAGNI 寄り。落とすか意図を1行で明記（architect）
- `src/shared/dictation.ts:55` — `altKey` を見ていないため Alt+Enter が通常の submit になる。
  `usePaneFocusShortcuts.ts:47` と同様に除外条件へ加えるか、無視する理由をコメントで固定（code）
- `src/renderer/src/components/DictationInput.tsx:34` — `e.nativeEvent.isComposing` を
  「React の deprecated なエイリアス」と誤記。実際に使っている正しい経路。事実どおりに書き換える（code）
- 端末→欄へのフォーカス到達手段が無い（欄→端末は Escape）。端末は Tab を pty へ送るため、
  後続要素からの Shift+Tab かマウスしか経路が無い。ホットキーは plan §6 でスコープ外
  （architect / requirements）
- `disabled` は要素を focusable でなくするため、pty が落ちた瞬間に欄に残っていた口述テキストは
  再送も編集もできない。R-7 が `disabled` を明文で要求しているので変更は ADR-0015 の改訂が前提
  （architect）
- `src/renderer/src/components/DictationInput.tsx:54-58` — 空欄/空白のみの Enter が `preventDefault`
  されず既定の改行挿入になる（空欄 Enter×2 で値が `"\n\n"`、欄が下へスクロールして壊れて見える）。
  `normalized` が空のときだけ `preventDefault` する（usability）。**2026-08-26 の実環境検証で再現確認済み**:
  実 claude 稼働中に空欄で Enter×2 → 欄の値が改行2つ分になり、端末側は無変化（送信はされていない）
- `src/renderer/src/styles.css:504-511` — プレースホルダ/disabled の `#7f7f7f` on `#252526` が約 3.8:1 で
  WCAG AA 未満。`styles.css:292-293` が自ら定めた 4.5:1 超の基準から後退。`#b8b8b8` 相当へ（usability）
- `DictationInput.tsx:65,70` — `aria-label` がアクセシブルネームを占めるため disabled 時の理由
  （プレースホルダ）が支援技術に届かず、文言も開始方法に触れていない。
  「＋ 新規セッション でセッションを開始すると使えます」へ（usability）
- `src/shared/dictation.ts:39-41` — IME 変換中の Escape でも `focusTerminal` を返すため、日本語ユーザーが
  習慣的に押す変換キャンセルで変換が消えたうえフォーカスが端末へ移り、以降の打鍵が claude へ生で流れる。
  `key === 'Escape' && isComposing` は `none` とし、`dictation.test.ts:87` の期待も反転（usability）
- `DictationInput.tsx:62-71` — テキストが入っている間、口述欄と端末内の claude 自身の入力行を
  区別する手掛かりがフォーカスリングと位置だけ（等幅・同系背景）。左端の小ラベルか
  フォーカス時の左ボーダー accent（usability）
- 既存 eslint error 2件（`src/renderer/src/components/EvaluationDashboard.tsx:59`、
  `src/renderer/src/hooks/useEvaluationForPurpose.ts:23`）が残り、`eslint .` が非0のままで rubric の
  ゲート1をリポジトリ全体としては満たしていない。M13 のスコープ外（code）
- `acceptance.md` R-7 第1項の文面（「unit テストで `paste` 非呼び出しを固定」）と実体（E2E で
  他ペインのバッファに現れないことを固定）のズレ。文面を実際の検証層に合わせて改訂する（requirements）
- `acceptance.md` R-9 第2項「red を確認してから green にした記録がビルドログに残る」が
  `docs/harness/log/M13-iter*.md` に無い。test-first の red 出力を1行残す運用にする（requirements）
- R-7 第3項（`running === false` で送信を試みても何も送られない）を観測するテストが無い。
  実装は `usePtyPane.ts:219` の `runningRef` ガードで満たしているが、テストは UI の `disabled` 確認のみ
  （requirements）
- R-5 の Escape（欄→端末へのフォーカス移動）の E2E が無い（純関数テストの `focusTerminal` 判定まで）。
  `focusPaneTerminal` fixture が既にあるので1ケースで足りる（requirements）

## 実環境検証で観測した別件（M13 とは無関係。要追加調査）

実 claude CLI での口述欄検証（2026-08-26、オーケストレータ実施）中、claude の statusLine に
`⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with
CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 to keep future transcripts` が表示された。
このときの cockpit は **claude セッションの中から Playwright 経由で起動**していたため、
`CLAUDE_CODE_CHILD_SESSION` が環境変数として孫プロセスまで継承された可能性がある。
継承されると claude が transcript を書かず、**cockpit のアーカイブ（本アプリの中核責務）が
無効になる**。通常起動（`cockpit-start.vbs` / デスクトップから）で同じことが起きるかは**未確認**。
提案: pty 起動時の env から `CLAUDE_CODE_CHILD_SESSION` を除去する（あるいは
`CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` を明示する）べきかを次回 `/cockpit-plan` で判断する。
