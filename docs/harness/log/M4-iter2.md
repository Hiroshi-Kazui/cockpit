# M4 — 反復2 記録（FIX：major 4件解消）

- 日付: 2026-07-19
- 実装: cockpit-implementer（FIX モード、反復1の major 4件＋minor）
- 静的ゲート（オーケストレータ実測）: tsc.node=0 / tsc.web=0 / eslint=0 / vitest 252/252 pass、dead IPC path 撤去確認 — green

## 変更ファイル（FIX 差分）
- src/shared/ipc.ts — ptySpawn/purposeCreateForPane channel/型を撤去
- src/main/ipc/handlers.ts — dead handler 2件撤去＋未使用 sessionCoordinator param 削除
- src/main/index.ts — registerIpcHandlers 呼び出し更新
- src/preload/index.ts — pty.spawn / purpose.createForPane 撤去
- src/main/pty/titleGenerator.ts — injectable TitleGeneratorExecFile＋stdin error 集約（+新規 titleGenerator.test.ts）
- src/main/pty/ptyManager.ts — per-spawn generation counter で superseded インスタンスの onData/onExit を無視（+新規 ptyManager.test.ts）
- src/shared/prompt.ts（新規）— normalizeInitialPromptText（+test）
- src/main/pty/purposeCoordinator.ts — armLaunch で多行正規化、resumeSession の spawn 先頭化（+test）
- src/renderer/src/components/Pane.tsx — 再開待ちの中央オーバーレイ（storyboard 準拠）
- src/renderer/src/components/PurposeDialog.tsx — Escape/Ctrl+Enter・フォーカストラップ・ヒント
- src/renderer/src/styles.css — オーバーレイ/ヒントの CSS

## verdict 要約
| reviewer | status | score | blocking |
|---|---|---|---|
| code | PASS | 94 | 0 |
| architect | PASS | 96 | 0 |
| usability | PASS | 93 | 0 |
| requirements | PASS | 95 | 0 |

## 反復1 major の解消確認
1. [解消] dead 第二起動経路（cockpit:pty:spawn / purpose:createForPane）撤去 → 起動は PurposeCoordinator 単一経路に集約。src 全 grep 0 件。
2. [解消] タイトル生成のコマンド注入不変条件 → injectable execFile＋titleGenerator.test.ts（argv 静的・prompt は stdin・メタ文字/空出力/EPIPE で reject）で固定。
3. [解消] 再起動後 UI → storyboard 準拠の中央「再開」オーバーレイ（自動起動しない旨の案内＋強調ボタン、xterm 常時マウント維持）。
4. [解消] respawn カップリング → PtyManager 内 generation counter（明示 kill は bump せず、respawn 時のみ旧世代を無視）。index/purposeCoordinator 無改変でハザード解消、テストで pin。

## 残 minor（→ 反復3 で解消）
- [architect] out/ の stale ビルド成果物に撤去済み channel 名（クリーン再ビルドで解消）
- [usability] cwd input の tabIndex={-1}／再開オーバーレイの role/aria-label
- [code] generations Map を kill() でも delete（対称）／respawn-while-running の orphan セッションを paneLaunchStart の isRunning ガードで封じる

## 最終判定
反復2: ゲート充足・major 全解消。closable minor が残るためワークフロー通り反復3（minor 収束）へ。
