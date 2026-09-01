# M14 残課題

- **`e2e/evaluation.spec.ts` の3テストが flaky（M14 以前からの競合。本マイルストーンの変更とは無関係）。**
  完了操作の前に待っているのが「セッション行が DB にできたこと」だけで、初回プロンプトのユーザ発言が
  スプールの transcript に届く前に「完了」を押してしまうことがある。その場合、評価は入力ゼロと判定されて
  `skipped` になり、`.evaluation-dialog__chart` が出ない。
  実測（2026-08-27、本リポジトリ）: 完了前に 10 秒待つと `userMessageCount: 1` / `status: 'ok'`、
  待たないと `userMessageCount: 0` / `status: 'skipped'`。同一ビルドで3連続実行しても 1 pass / 2 fail。
  → 修正案: `e2e/stop-cleanup-and-appeal.spec.ts` の `waitForArchivedUserTurn`（`archive.readSession` で
  user ロールの turn が1件以上入るまで待つ）と同じ待ちに差し替える。M14 の依頼範囲外のため未適用。
- `e2e/git-sync.spec.ts` の「dirty case」も red だが、これも M14 の変更を `git stash` した clean tree で
  同じ失敗を再現済み（native alert の本文にリポジトリパスが含まれない）。M14 とは無関係。
- `npx eslint .` は M14 以前から 2 件 red（`EvaluationDashboard.tsx:59`,
  `useEvaluationForPurpose.ts:23`。いずれも M14 で触っていないファイル）。
