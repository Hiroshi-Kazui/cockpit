# M1 — 反復1 記録

- 日付: 2026-07-19
- 実装: cockpit-implementer（初回 IMPLEMENT M1）
- 静的ゲート（オーケストレータ実測）: tsc.node=0 / tsc.web=0 / eslint=0 / vitest 16/16 pass — green

## 変更ファイル（主なもの）
package.json, tsconfig*.json, electron.vite.config.ts, vitest.config.ts, eslint.config.js,
README.md, patches/node-pty+1.1.0.patch,
src/shared/{ipc.ts,layout.ts,layout.test.ts},
src/main/index.ts, src/main/pty/{resolveClaude.ts,resolveClaude.test.ts,ptyManager.ts},
src/main/db/{db.ts,paneSettingsRepo.ts,appSettingsRepo.ts}, src/main/ipc/handlers.ts,
src/preload/{index.ts,index.d.ts},
src/renderer/index.html, src/renderer/src/{main.tsx,App.tsx,styles.css},
src/renderer/src/components/{LayoutSwitcher,Pane,PaneGrid}.tsx,
src/renderer/src/hooks/usePtyPane.ts

## verdict 要約
| reviewer | status | score | blocking |
|---|---|---|---|
| code | PASS | 91 | 0 |
| architect | PASS | 91 | 0 |
| usability | FAIL | 58 | 1 |
| requirements | PASS | 92 | 0 |

## 集約 blocking（→ 反復2 へ差し戻し）
1. [blocking] src/renderer/src/main.tsx — `@xterm/xterm/css/xterm.css` が未 import で端末描画が崩れる（spec §4.1 / AC #5 の CLI UX 無損失素通しを毀損）。renderer エントリで import を追加し実機で描画確認する。

## 併せて修正指示した非 blocking（usability を 85+ へ引き上げるため）
- [major] usePtyPane.ts — spawn 成功後に term.focus() を呼ばず起動直後にキー入力が pty に届かない。
- [minor] index.ts — webContents.send に isDestroyed() ガード欠如（architect+code 重複指摘）。
- [minor] ptyManager.ts:39 — process.env の緩い型キャスト（architect+code+requirements 重複指摘）。
- [minor] App.tsx/Pane.tsx — claude 未解決時も「claude 起動」ボタンが活性。
- [minor] styles.css — アクティブペインの :focus-within 強調なし / .pane-cwd のコントラスト不足。

## 最終判定
反復1: **FAIL**（usability blocking 1件）。反復2（FIX）へ。
