# ADR-0015 — ペイン下部の口述入力欄と、そこから pty へ送る経路

- 状態: proposed
- 日付: 2026-08-26
- 関連: spec §4.1（生 pty 素通し）、ADR-0014 / コミット 1a78edb（実行中リサイズの排除）、
  TD-5（Windows での claude spawn）

## 文脈

Aqua Voice（Windows）の自動挿入が cockpit のペインに入らない。2026-08-26 セッションでの実測:

| 経路 | 結果 |
|---|---|
| Aqua の自動挿入（常にリアルタイム / 常にインスタント）→ ペイン（xterm.js の隠し textarea） | 入らない |
| Aqua の「最後の文字起こしを貼り付け」ホットキー → ペイン | **入る** |
| 口述後に手で Ctrl+V → ペイン | 入らない |
| Aqua の自動挿入 → 目的入力ダイアログの `<textarea>`（普通の HTML 要素） | **入る** |

外部報告（claude-code issue #51725 / #38620 / #39983 / #53451）でも、Windows で擬似キーストローク入力が
claude の TUI に届かない事例が複数上がっており上流は未修正。したがって「xterm.js の隠し textarea に
Aqua が挿入できるようにする」方向は cockpit 側では閉じられない。

一方、**普通の `<textarea>` には自動挿入が届く**ことが実測できている。よって cockpit 側に普通の入力欄を
用意し、そこから pty へ送る経路を作れば、Aqua の設定変更も追加キーも不要で口述が使える。

## 決定

### D-1: 挿入は `Terminal.paste()` に委譲し、新規 IPC を作らない

入力欄のテキストは renderer で `term.paste(text)` に渡す。送信の CR も `term.input('\r')` で同じ
Terminal に渡す。どちらも xterm.js 内部で `onData` を発火するため、**バイト列は既存の
`term.onData → window.cockpit.pty.write` を通る**（`src/renderer/src/hooks/usePtyPane.ts:124`）。
新しい IPC チャネルは追加しない。

理由: bracketed paste（`ESC[200~ … ESC[201~`）で括ってよいかは、claude 側が DECSET 2004 を有効にして
いるかに依存する。それを知っているのは xterm.js だけで、`paste()` の実装はまさにその判定を持つ
（実測: `node_modules/@xterm/xterm/lib/xterm.js` の paste 経路は
`bracketTextForPaste(text, decPrivateModes.bracketedPasteMode && !ignoreBracketedPasteMode)` →
`triggerDataEvent(text, true)`）。cockpit 側で括り方を再実装すると、モードが無効なときに生の
`ESC[200~` が claude に流れる。判定を二重実装しないこと自体が要件（CLAUDE.md: 副作用と判断の集約）。

### D-2: 送信前に改行を空白へ潰す（`normalizeInitialPromptText` を再利用）

bracketed paste が無効な場合、xterm.js の `prepareTextForTerminal` が改行を CR に変換するため、TUI には
複数回の Enter に見えて途中で送信されてしまう。`PurposeCoordinator` が初回プロンプトで既に同じ理由で
同じ関数を通している（`src/main/pty/purposeCoordinator.ts:220`）。口述入力も同じ規則に揃える。

帰結: 欄内の Shift+Enter は「読みやすく書くための改行」であり、送信時には空白1つになる。改行をそのまま
claude に渡すことは本マイルストーンのスコープ外。

### D-3: 入力欄は常設・定数高。条件付きレンダリングしない

欄が出入りするとペインの端末の行数が変わる。ConPTY は自分の画面認識を resize ごとに再描画するため、
xterm.js がスクロールバックへ送った行との対応が崩れる（1a78edb で `.pane-info` を定数高に集約して
根絶した崩れそのもの。M12 followups の記述も「cockpit 自身の実行中リサイズは無くなった」を前提にしている）。
よって欄は pty の起動状態やレイアウトに関わらず常に同じ高さで存在し、内容が増えても伸びず内部で
スクロールする。

### D-4: 欄はペインごとに持ち、そのペインにだけ送る

「アクティブペイン」という新しい概念を導入しない。ペイン `n` の欄はペイン `n` の pty にだけ送る。
どこに送られるかが画面上の位置で自明になる。

### D-5: pty 未起動時は欄を無効化する

送信先が無い状態でテキストを受け取って捨てるのは silent failure。`usePtyPane` の `running` が false の
間は欄を `disabled` にし、プレースホルダで理由を示す。

### D-6: キー割り当て

| キー | 挙動 |
|---|---|
| Enter | 1行化したテキストを `paste()` → `input('\r')`。欄を空にする |
| Shift+Enter | 欄内の改行（送信しない） |
| Ctrl+Enter | `paste()` のみ（CR を送らない）。claude の入力欄に置くだけで送信しない |
| Escape | 欄を離れてそのペインの端末へフォーカスを戻す |

IME 変換確定の Enter（`isComposing`）では送信しない。日本語入力で変換確定が送信になってしまうのを防ぐ。
`Ctrl+1..4`（ペイン間フォーカス移動、M5）の既存挙動は変更しない。

### D-7: 素通し原則との関係

spec §4.1 の「生の pty 入出力を素通しする」は維持する。xterm.js の入力経路（keydown / composition /
paste / `input` イベント）には一切手を入れず、この欄は**ユーザーが明示的に使う別の入口**として足す。
pty 出力の解釈・加工も行わない。

## 却下した代替案

- **クリップボード監視 → 自動挿入**: 口述後に手で Ctrl+V してもペインに入らなかった（T1 NG）ため、
  そもそもクリップボードに文字起こしが載っていない可能性がある。前提が実測で否定された。
- **xterm.js の入力受け口の改造**（隠し textarea の `input` イベントを独自に拾う等）: Aqua の自動挿入が
  そもそも隠し textarea に届いているかが未確認で、届いていなければ何を足しても無効。上流（claude-code）
  側の未修正報告もあり、当てにできない。
- **cockpit 自前の音声認識**（マイク → Whisper 等）: Aqua という既存の道具が普通の入力欄では動くのに、
  責務（起動・表示・記録）外の機能を抱える理由がない。
- **ホットキーで開くモーダルの口述欄**: 画面領域を食わない利点はあるが、口述ごとに開くキーが1つ増える。
  ユーザーは常設欄を選択（2026-08-26）。
