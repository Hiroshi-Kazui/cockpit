# M4 — 反復3 記録（minor 収束：課題ゼロ到達）

- 日付: 2026-07-19
- 契機: 確立済みワークフロー「課題がなくなるまで修正の反復」
- 実装: cockpit-implementer（FIX モード、残 minor 5件）
- 静的ゲート（オーケストレータ実測）: tsc.node=0 / tsc.web=0 / eslint=0 / vitest 258/258 pass、out/ の stale channel 残骸ゼロ — green

## 変更ファイル
- out/（`npm run build` でクリーン再生成、撤去済み channel 名の残骸ゼロを grep で確認。source は不変）
- src/renderer/src/components/PurposeDialog.tsx — read-only cwd input に tabIndex={-1}
- src/renderer/src/components/Pane.tsx — 再開オーバーレイに role="group"＋aria-label（目的タイトル）
- src/main/pty/ptyManager.ts — kill()/killAll() で generations も delete（対称化）。onData/onExit は「entry 欠落＝not superseded」の意味論に（+test）
- src/main/ipc/handlers.ts — paneLaunchStart/paneLaunchResume に isRunning ガード（running 中は throw、orphan セッション封じ）（+新規 handlers.test.ts）

## 解消した minor
- [architect] out/ の stale ビルド成果物 → クリーン再ビルドで解消（out/ の channel 名が現行 IpcChannels と完全一致）
- [usability] cwd input の tabIndex / 再開オーバーレイの a11y → 付与
- [code] generations Map の対称クリア → kill()/killAll() で delete、世代ガードは単調増加世代番号ゆえ superseded-leak を原理的に排除、(a)明示kill後の自己onExit伝播と(b)respawn時の旧世代drop両立をテストで固定
- [code] respawn-while-running の orphan セッション → isRunning ガードで purpose/session 生成前に拒否。TD-3 の ended_at 確定・orphan 回避と整合する改善

## verdict 要約（全員 指摘ゼロ）
| reviewer | status | score | non-blocking |
|---|---|---|---|
| code | PASS | 96 | なし |
| architect | PASS | 99 | なし |
| usability | PASS | 96 | なし |
| requirements | PASS | 96 | なし |

## 収束判定
4体とも「3反復で収束、closable な課題なし」と明言。isRunning ガードの handler 層配置は「pty 稼働状態と purpose ライフサイクル意図の両方が同時に見える唯一の層」として architect が妥当と評価。

## 唯一の未クローズ事項（M5 スコープの残タスク）
- **TD-1 の起動検知（statusLine が対話前に発火するか）の実 pty 実測**: この harness には対話的 claude TUI を起こせる実 pty が無いため実測不可。実装は主信号（statusLine 初回）＋700ms 静止フォールバック＋10s タイムアウトの二段構えを備え静的観点では TD-1 準拠。実 pty での確定は M5 の Playwright+Electron E2E スコープの残タスクとして区別。

## 最終判定
**M4 は課題ゼロに収束**（4体全員 PASS・指摘ゼロ・静的ゲート green、vitest 258/258）。反復数: M4 iter1〜3（合格 iter2、minor 収束 iter3）。残るは TD-1 実 pty 実測（M5 E2E スコープ）のみ。
