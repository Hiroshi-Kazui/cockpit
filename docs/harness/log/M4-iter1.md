# M4 — 反復1 記録

- 日付: 2026-07-19
- 実装: cockpit-implementer（初回 IMPLEMENT M4）
- 静的ゲート（オーケストレータ実測）: tsc.node=0 / tsc.web=0 / eslint=0 / vitest 231/231 pass — green

## 主な新規/変更ファイル
shared/{title.ts,launchReadiness.ts}(+test), ipc.ts,
main/pty/{launchReadinessWatcher.ts,titleGenerator.ts,purposeCoordinator.ts}(+test),
main/db/{purposeRepo.ts,sessionRepo.ts}, main/telemetry/{sessionCoordinator.ts,ports.ts}, main/pty/ptyManager.ts,
main/{index.ts,ipc/handlers.ts}, preload/index.ts,
renderer/src/components/{PurposeDialog.tsx,Pane.tsx,PaneGrid.tsx}, App.tsx, hooks/usePtyPane.ts, styles.css

## verdict 要約
| reviewer | status | score | blocking |
|---|---|---|---|
| code | PASS | 88 | 0 |
| architect | PASS | 90 | 0 |
| usability | PASS | 87 | 0 |
| requirements | PASS | 93 | 0 |

## ゲート判定
全員 PASS・score≥85・静的ゲート green → ゲート条件は充足。ただし複数レビュアーが一致指摘した major が残るため、確立済みワークフロー（課題ゼロまで反復）に従い反復2（FIX）へ。

## 集約 major（→ 反復2 へ差し戻し）
1. [major][code+architect] 旧 cockpit:pty:spawn（＋purpose:createForPane）が renderer 未使用のまま残存＝PurposeCoordinator をバイパスし「目的なし・タイトルなし」で起動しうる分岐した第二経路の罠。撤去 or 下位/テスト専用 API と明示。
2. [major][code] タイトル生成のコマンド注入回避（purpose 原文を argv に載せず stdin）に専用テストが無い。injectable spawn で不変条件をテスト固定。
3. [major][usability] 再起動後「再開待ち」表示が storyboard の明示アフォーダンス（中央「継続中の目的があります／自動起動しません」＋強調ボタン）を欠き、空ターミナル＋小ボタンで意図が伝わりにくい。
4. [major][architect] respawn-while-running と exit 駆動 cancelLaunch の潜在カップリング（旧 pty の onExit が新 launch watcher を dispose しうる。M5 で顕在化）。pty 世代 ID ガード。

## 併せて修正指示した minor
- [usability] ダイアログの Escape/Ctrl+Enter・フォーカストラップ
- [requirements] 多行目的テキストの中間改行を送信時に空白正規化
- [architect] resumeSession の副作用順序を startNewSession と対称化
- [code] titleGenerator の child.stdin error ハンドラ（EPIPE 集約）

## non-blocking（今回スコープ外・M5/据え置き）
- TD-1 の実 pty 実挙動未検証（M5 E2E で実測）、module-level wiring 2段整理、paneSettingsSetCwd の server 側 confirm、origin='resume' 未使用。

## 最終判定
反復1: ゲート充足だが major 4件残存。反復2（FIX）へ。
