# cockpit マイルストーン受け入れ基準

requirements-reviewer の逐条トレース基準であり、implementer の実装スコープ定義。
各項目は「どのファイル/関数が満たすか」を特定できなければ未達扱い。
共通ゲート（全 M）: `tsc --noEmit` / `eslint` / `vitest run` が green（rubric 参照）。

## M1 — シェル・ペイン・pty 起動

- [ ] `npm run dev` で Electron ウィンドウが起動する
- [ ] レイアウト 1 / 2分割 / 4分割 を UI から切替できる（最大4ペイン、spec §4.1）
- [ ] 各ペインでデフォルトフォルダを設定でき、SQLite `pane_settings` に永続化、再起動後に復元される
- [ ] ペインごとに claude CLI を独立 pty で起動できる（cwd = デフォルトフォルダ、TD-5 の実体解決）
- [ ] キー入力・出力が生のまま素通しされる（スラッシュコマンド・権限確認が正常動作、spec §4.1）
- [ ] ペインリサイズが pty の cols/rows に伝播する
- [ ] `nodeIntegration: false` / `contextIsolation: true`、IPC 契約は `shared/` で型付き定義
- [ ] native module（node-pty, better-sqlite3）の electron-rebuild がセットアップ手順に含まれ、動作する
- [ ] claude 実体解決失敗時にユーザーへ分かるエラー表示（silent failure 禁止）

## M2 — テレメトリ・紐付け・アーカイブ

- [ ] アプリ生成 settings（`--settings`）で statusLine フォワーダが登録される（spec §4.3, TD-4）
- [ ] フォワーダが名前付きパイプで JSON を転送し、既存 statusLine 設定をチェーン呼び出しで維持する
- [ ] フォワーダはアプリ不在でも claude をブロックしない（タイムアウト 200ms、TD-4）
- [ ] transcript_path でセッションを紐付け、chokidar で追記監視、アーカイブへ同期コピー（元ファイル不変、spec §4.4）
- [ ] メタデータ JSON を併置（session_id, pane, purpose, title, cwd, 開始・終了時刻, model, 累計トークン）
- [ ] `sessions` 行の作成・更新。`origin` 列（dialog/clear/resume/restart, TD-2）と `purpose_id`。ended_at は TD-3 の3経路
- [ ] /clear による session_id 変化で新行が作られ、ペインの active な purpose に紐付き purpose/title が引き継がれる（TD-2）
- [ ] `purposes` テーブルが spec §5 どおり存在する（status/created_at/completed_at）
- [ ] アーカイブに削除・編集の経路が存在しない（append-only、spec §4.4）
- [ ] JSONL / statusLine パーサは未知フィールド無視・欠落許容（spec §7）で、unit テストがある
- [ ] クラッシュ後の再起動で open セッションが修復クローズされる（TD-3）

## M3 — 使用量可視化（コンテキスト消費・残量）

- [ ] ペインごとに statusLine のコンテキストウィンドウ使用率から**コンテキスト消費量ゲージ**（compact までの目安、〜59% 緑 / 60〜84% オレンジ / 85%〜 赤）を表示し、やり取りのたび更新（spec §4.5）
- [ ] JSONL の usage（input/output/cache read/cache write）集計＝累計トークンはセッションメタデータ（§4.4/§5）として記録する（ペイン内の主表示はコンテキストゲージ。累計トークンの棒グラフは主表示にしない）
- [ ] ステータスバーに 5時間/週次の残り%（100−used_percentage）＋棒グラフ＋リセットまでの残り時間（rate_limits 実測値）
- [ ] 更新はやり取り発生ごとに即時。定期ポーリングは存在しない
- [ ] 全ペイン5分アイドル時のみ `GET /api/oauth/usage` を**単発**照会（spec §4.5。定期実行コードがないこと）
- [ ] rate_limits 欠落時はローカル集計＋プラン上限（Pro/Max5x/Max20x プリセット、手動調整可）の推定表示に切替わり、「推定」バッジが明示される
- [ ] 集計・残量計算は `shared/` の純関数で、unit テストがある

## M4 — 起動フロー・タイトル生成

- [ ] 「新規セッション」で目的入力ダイアログが表示され、目的テキスト（**任意入力**。空でも開始可）が保存される（spec §4.2）
- [ ] 起動完了検知は TD-1（statusLine 初回イベント主信号＋700ms 静止フォールバック＋10s タイムアウト）
- [ ] 目的テキストがある場合、検知後に最初のプロンプトとして自動送信される
- [ ] **目的が空で開始した場合**: 初回プロンプトの自動送信は行わず、セッション JSONL の**最初の非コマンド（`/` で始まらない）ユーザ発言**を目的テキストとして採用し、タイトルを生成する（spec §4.2）
- [ ] 目的決定前はペインヘッダに「未設定」を表示。一度も発言せずセッションを終えた場合は未設定のまま（spec §4.2/§4.6）
- [ ] `claude -p --model haiku` で約20字のタイトルが生成されペインヘッダに表示される
- [ ] タイトル生成失敗時は目的テキスト先頭の切り出しでフォールバック（エラーは握り潰さずログ）
- [ ] タイトル生成はペイン操作をブロックしない（非同期）
- [ ] ダイアログ確定で `purposes` 行が作成され（status=active）、セッションが紐付く（spec §4.6）
- [ ] ペインヘッダの「完了」操作で目的が completed になり、以後の新規セッションは再びダイアログから（spec §4.6, TD-7）
- [ ] アプリ再起動後、active な目的を持つペインに目的タイトル＋「再開」ボタンが復元される（自動起動はしない）
- [ ] 「再開」押下で同 cwd・`--continue` 付きで claude が起動し、`origin='restart'` のセッション行が作られる（TD-7）
- [ ] active な目的を持つペインのデフォルトフォルダ変更時に警告が出る（TD-7）

## M5 — 閲覧 UI・磨き込み

- [ ] 過去セッションの一覧（SQLite index 由来）を検索・閲覧できる（spec §4.4）
- [ ] 閲覧は読み取り専用。アーカイブへの編集・削除 UI が存在しない
- [ ] レイアウト切替時にペイン内容（実行中セッション）が壊れない
- [ ] キーボードでのペイン間フォーカス移動
- [ ] E2E（Playwright + Electron）で主要フロー（起動→セッション開始→記録→閲覧）が green
