# M12 受け入れ基準 — 同梱 ConPTY（useConptyDll）への切替

requirements-reviewer が逐条トレースする。各項目は満たすファイル/関数を特定できること。

## R-1: spawn 切替

- [ ] `src/main/pty/ptyManager.ts` の `spawn()` が node-pty へ `useConptyDll: true` を渡す
- [ ] 環境変数 `COCKPIT_DISABLE_CONPTY_DLL=1` が設定されているときのみ `useConptyDll: false`
      （または未指定）で spawn する
- [ ] unit テスト（`ptyManager.test.ts`、node-pty mock）が両分岐の spawn オプションを assert する
- [ ] 判定は環境変数の有無を握り潰さない（値の解釈規則をコメントか関数名で明示。silent failure 禁止）

## R-2: hostInfo の整合（二重実装の禁止）

- [ ] `src/main/pty/windowsPtyInfo.ts`（または後継モジュール）が「useConptyDll 有効/無効 ×
      platform × release」から `WindowsPtyInfo | null` を導出する**単一の純関数**を持つ
- [ ] spawn 側の useConptyDll 判定と renderer へ報告する `windowsPty` が同一モジュールの
      判定から導出される（grep で選択ロジックが2箇所に現れないこと）
- [ ] 純関数は test-first（実装前に red を確認したことがコミット履歴または PR 記述で追える）
- [ ] winpty fallback（build < 18309）時に useConptyDll が無視されることを node-pty ソースで
      確認し、確認結果（該当行）をコード内コメントまたは plan 追記で引用する

## R-3: 既存挙動の維持

- [ ] `src/main/pty/ptyManager.test.ts` の既存テスト（respawn 世代ガード・kill・getRunningCwd）が
      変更なしで green
- [ ] `src/main/pty/windowsPtyInfo.test.ts` の既存テストが（API 変更に伴う機械的追従を除き）green
- [ ] `npm run lint` / `tsc --noEmit` / unit 全件 green

## R-4: E2E 回帰

- [ ] `e2e/terminal-repaint.spec.ts` の4テストが green
      （行数変化・報告素材・行頭再描画・セッション開始時行数不変）
- [ ] 既存 E2E スイート全体が green（closeApp 経路のシャットダウン挙動差が出ないこと）
- [ ] exit 通知 `[claude exited: code=…]` が同梱 ConPTY 上でも表示される
      （既存 E2E がカバーしていなければ1本追加）

## R-5: 実機確認（本マイルストーンの合否を決める仮説検証）

- [ ] 実 claude CLI を1ペインで起動し、長い CJK 混在出力（terminal-repaint.spec.ts の
      REPORTED_MATERIAL 相当）をスクロール（PageUp・マウスホイール）して、
      左ずれ・行頭残りが 0 件であることを確認
- [ ] 実行中にウィンドウリサイズおよび分割線ドラッグを行い、崩れが再現しないことを確認
- [ ] `COCKPIT_PTY_LOG_DIR` の recorder ログを取得し、確認手順・結果を
      `milestones/M12-conpty-passthrough/` 配下に記録する
- [ ] 崩れが再現した場合は fix で吸収せず BLOCKED として停止しユーザーに諮る（plan §5）
