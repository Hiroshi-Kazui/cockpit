# M6 受け入れ基準 — アーカイブ出力先の設定（ミラー）

requirements-reviewer の逐条トレース基準であり、implementer の実装スコープ定義。
各項目は「どのファイル/関数が満たすか」を特定できなければ未達扱い。
共通ゲート（全 M 共通）: `tsc --noEmit` / `eslint` / `vitest run` が green（`docs/harness/review-rubric.md` 参照）。
出荷（shipped）後、本チェックリストの恒久部分は unit / E2E テストが回帰の正となる。

- [ ] 出力先未設定時は M5 までと完全に同一動作（回帰なし）。`archive_output_root` 未設定ならミラー系を起動しない（spec §4.4.1, main/index.ts）
- [ ] 設定 UI から出力先フォルダを選択でき（`dialog.showOpenDialog`）、書き込みプローブ検証に通れば `app_settings.archive_output_root` に永続化される（spec §4.4.1, ADR-0008/D-5）
- [ ] スプール（`userData/archive`）自身・配下は出力先に指定不可（自己ミラー防止。`shared/paths.ts` の containment で判定, ADR-0008/D-5）
- [ ] 出力先設定後の新規セッションで、ミラー先に `<session_id>/transcript.jsonl` と `metadata.json` が生成され、スプールと内容が一致（spec §4.4.1, main/archive/mirror/*）
- [ ] ミラーはスプール→出力先の非同期追記差分同期（結果整合）で、pty / renderer をブロックしない（fire-and-forget, TD-4 同思想 / ADR-0008/D-2）
- [ ] 出力先切断（オフライン・フォルダ削除相当）でもセッション記録は継続し、復旧後に未同期分が追い付く。UI にエラー状態が表示される（spec §4.4.1, silent failure 禁止）
- [ ] スプール・ミラー先のどちらにも削除・編集の経路が存在しない（append-only, spec §4.4/§4.4.1）。ミラー先がスプールより大きい場合は上書きせずエラー化（append-only 違反検出）
- [ ] `archive_mirror` テーブルが spec §5 どおり存在し、起動時にスプールと突合して未同期分を回収（クラッシュ復旧, ADR-0008/D-6）
- [ ] 出力先変更後、旧出力先のデータは無変更のまま残り、新規分のみ新出力先へ同期される（spec §4.4.1, ADR-0008/D-4）
- [ ] バックフィル操作で過去セッションがミラー先に複製され、進捗・完了/失敗が UI に表示される（spec §4.4.1, 自動実行しない）
- [ ] SQLite DB（cockpit.db）は userData 固定でミラー対象外（ADR-0008/D-1）
- [ ] ミラー計画・出力先妥当性判定は `shared/`（`mirrorPlan.ts`）の純関数で、unit テストがある
- [ ] E2E（Playwright + Electron）: 出力先設定→セッション実行→ミラー生成、切断→エラー表示→スプール無傷→復旧で追い付き、が green
