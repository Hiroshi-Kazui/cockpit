# ADR-0014 — pty ホスティングを node-pty 同梱 ConPTY（useConptyDll）へ切替える

- 状態: proposed
- 日付: 2026-08-11
- 関連: TD-5（Windows での claude CLI spawn）、ADR-0012（端末可観測性）

## 背景

表示崩れ（スクロール/再描画時の左ずれ・行頭残り）への対処は、これまで全て
「claude CLI → ConPTY の再翻訳 → xterm.js の再解釈」という三重解釈パイプラインの
**第2・第3段の食い違いを個別に塞ぐ**ものだった:

1. `windowsPty` オプションで xterm.js に ConPTY の行増減挙動を教える（usePtyPane.ts）
2. ペインの情報行・ゲージを定数高にして実行中の pty リサイズ自体を無くす（1a78edb）
3. `convertEol` を外して ConPTY の LF-index 部分再描画を壊さない（cec54ae）

いずれも「OS 組み込み conhost 版 ConPTY が自前のスクリーンバッファを持ち、
画面を再翻訳・再描画する」という発生機構そのものは残している。ユーザー操作による
リサイズ経路、および xterm.js（Unicode 6 幅テーブル）と conhost の文字幅不一致は未対処。

## 決定

**D-1**: `ptyManager.spawn()` に `useConptyDll: true` を渡し、OS の conhost 版 ConPTY ではなく
node-pty 1.1.0 が同梱する conpty.dll（`third_party/conpty/1.23.251008001/`、
Windows Terminal 系譜。win32-x64 prebuilds に conpty.dll + OpenConsole.exe が存在することを実測済み）
で pty をホストする。Windows Terminal 1.22 以降の ConPTY は旧来の
「自前バッファを持って repaint する」翻訳層を廃した設計であり、上記機構の根絶を狙う。
**注意: 崩れ解消の効果は本環境で未実測。M12 acceptance の実機確認（R-5）で確定するまで仮説である。**

**D-2**: 逃げ道として環境変数 `COCKPIT_DISABLE_CONPTY_DLL=1` で従来の OS 版 ConPTY に戻せる
（`COCKPIT_PTY_LOG_DIR` と同じ「環境変数による診断スイッチ」の先例に従う。UI 設定にはしない）。
useConptyDll は node-pty が EXPERIMENTAL と明示する機能であり、明示的なフォールバックを持つ。

**D-3**: renderer へ報告する `windowsPty`（windowsPtyInfo.ts）は spawn 側の実際の選択を反映する。
「node-pty の既定規則を鏡写しする」現行方針を「cockpit が spawn に渡した事実を鏡写しする」に改める。
選択ロジックは1箇所（spawn とhostInfo が同じ関数から導出）に置き、二重実装にしない
（M10 followups「錨判定ルールの二重化」と同型の再発防止）。
buildNumber は従来どおり `os.release()` 由来のまま（本機は 26200 ≥ 21376 で reflow 有効。
より古いホストで同梱 dll の能力を過小報告しうるが、本アプリは単一 Windows 11 環境固定でスコープ外）。

## 却下した代替案

- **stream-json による自前描画（案B）**: 端末エミュレーション自体を消す究極形だが、
  spec §4.1「生 pty 素通し・CLI 対話 UX を一切損なわない」と正面衝突し製品の再設計になる。
- **@xterm/addon-unicode11 の追加**: 幅テーブル不一致のみへの対症で、conhost の repaint 機構は残る。
  D-1 で不要になるかを R-5 実測後に判断（必要なら別マイルストーン）。
- **winpty への後退**: より古い翻訳層であり逆行。

## 帰結・リスク

- useConptyDll は node-pty 内で kill / exit-code / clear / ConoutConnection dispose の
  処理系が分岐する（windowsPtyAgent.js 実測: 137-156, 224-240 行）。exit 通知・respawn
  世代ガードの既存挙動を unit + E2E で固定してから切替える。
- useConptyDll が conpty 経路でのみ有効（winpty fallback 時に無視）であることの確認は実装時に
  node-pty ソースで検証する（未検証）。
- 将来アプリをパッケージングする際は conpty.dll / OpenConsole.exe の同梱が必要
  （現状は electron-vite dev/build のみで electron-builder 未導入。実測済み）。
- patch-package の `node-pty+1.1.0.patch` は binding.gyp の SpectreMitigation のみで本決定と干渉しない（実測済み）。
