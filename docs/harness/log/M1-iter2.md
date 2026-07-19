# M1 — 反復2 記録（FIX → 合格）

- 日付: 2026-07-19
- 実装: cockpit-implementer（FIX モード、反復1の集約 blocking/major/minor 対応）
- 静的ゲート（オーケストレータ実測）: tsc.node=0 / tsc.web=0 / eslint=0 / vitest 16/16 pass — green

## 変更ファイル（FIX 差分）
- src/renderer/src/main.tsx — `@xterm/xterm/css/xterm.css` を import（blocking 対応、cascade は styles.css の前）
- src/renderer/src/hooks/usePtyPane.ts — spawn 成功後に term.focus()（major 対応）
- src/main/index.ts — onData/onExit の webContents.send に isDestroyed() ガード（minor 対応）
- src/main/pty/ptyManager.ts — process.env の型キャストを cleanEnv() へ置換（minor 対応）
- src/renderer/src/App.tsx, components/PaneGrid.tsx, components/Pane.tsx — claude 未解決時に「claude 起動」ボタンを無効化＋title（minor 対応、claudeResolved を prop 伝播）
- src/renderer/src/styles.css — .pane:focus-within 強調・disabled ボタン・.pane-cwd コントラスト #9d9d9d→#b8b8b8（minor 対応）

## verdict 要約
| reviewer | status | score | blocking |
|---|---|---|---|
| code | PASS | 93 | 0 |
| architect | PASS | 93 | 0 |
| usability | PASS | 89 | 0 |
| requirements | PASS | 94 | 0 |

## 反復1 blocking の解消確認
- [解消] xterm.css 未 import → main.tsx で import 追加、実体解決・cascade 順を確認。CLI UX 無損失素通し（spec §4.1 / AC #5）回復。

## 残存 non-blocking（M1 では許容、後続で検討可）
- resolveStatus 解決前は起動ボタンが一時有効（フリッカ回避の既定値。spawn 失敗はエラー表示で捕捉）
- 起動前ペイン端末の操作誘導が薄い（初回 UX 磨き込み、M5）
- display:none ペインの ResizeObserver 0 サイズ fit（M5 レイアウト非破壊要件と合わせて）
- cleanEnv が full env を子プロセスへ継承（M2 の --settings 導入時に env サニタイズ方針を明文化）

## 最終判定
**M1 合格**（4レビュアー全員 PASS・score≥85・静的ゲート green）。反復数: 2。
次マイルストーン（M2）へは自動で進まず、ユーザー指示を待つ。
