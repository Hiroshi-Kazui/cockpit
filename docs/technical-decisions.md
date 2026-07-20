# cockpit 技術決定事項（TD-1〜TD-7、凍結）

spec（`claude-multi-window-spec.md`）が実装に委ねている judgment call を確定させる文書。
spec と本書が矛盾する場合は spec が優先だが、本書は spec の「空白」を埋める位置づけ。
決定日: 2026-07-19（ユーザー承認済み）

> **本書は凍結**（コード・過去ログからの `TD-n` 参照を保つため現状のまま維持）。
> **新規の技術決定は `docs/adr/` に1決定1ファイルで追加する**（索引: `docs/adr/README.md`。
> TD-1〜TD-7 は ADR-0001〜0007 に対応し、ADR-0008 以降が新規）。

## TD-1: 起動完了検知（spec §4.2「起動完了を検知後」）

**決定**: 二段構え。
1. **主信号**: statusLine フォワーダの**初回イベント受信**。Claude Code は UI 描画のたびに
   statusLine コマンドを起動するため、初回発火 = TUI 準備完了とみなす。
2. **フォールバック**: pty 出力開始後、**700ms 出力静止**で準備完了とみなす。
   最大 **10秒** で強制タイムアウト（その時点で送信を試みる）。

初回プロンプト送信はテキスト＋`\r`。statusLine が起動直後（対話前）に発火するかは
M4 実装時に実測確認し、発火しない場合は静止検知を主信号に昇格する。

**実測結果（M5, 2026-07-20, 実 claude CLI v2.1.205 / node-pty 経由・キー入力ゼロで観測）**:
主信号の前提は**確認された**。実行フローは以下の2パターンに分かれる。
- **既に信頼済みのフォルダ**（ペインの「デフォルトフォルダ」を過去に使用済み、実運用上の主要ケース）:
  対話（チャットメッセージ送信）より前に、初回描画（ウェルカム画面）の時点で statusLine が発火する
  ことを確認。キー入力を一切送らない状態で観測。
- **未信頼（初回）フォルダ**: claude 自身が「このフォルダを信頼しますか」という**ローカルの
  Yes/No 確認ゲート**を表示し、これに答えるまで statusLine は一切発火しない（キー入力ゼロで
  5秒待機して確認）。このゲートはモデル呼び出しを伴わないローカル確認であり、「対話」
  （チャットメッセージ送信）そのものではないため、TD-1 の「対話前に発火」という主信号の前提は
  依然として成立する。ゲートへの回答（"1"+Enter）後、約1.6秒でウェルカム画面とともに
  statusLine が発火し、その時点でもチャットメッセージは一切送信されていないことを確認した。

  結論: 主信号は本実装のまま維持する（静止検知への昇格は不要）。ただし新規フォルダでの
  初回起動時は、信頼確認ゲートが数秒〜ユーザーが応答するまでの間、statusLine 発火を遅延させうる
  ことを既知の制約として記録する（フォールバック — 700ms静止検知・10秒タイムアウト — が
  この間の保険として機能する）。測定手順は `e2e/probes/td1-statusline-probe.js`
  （`npm run test:e2e` には含まれない opt-in 診断スクリプト。詳細は当該ファイルのヘッダコメント参照）。
  probe は起動した実行バイナリの `--version` も自己記録する（probe 自身の実装として。
  チャットメッセージは送信しない）。

  **バージョン源についての注記**: 本 TD-1 の実測は実行バイナリ（`claude --version` = 2.1.205,
  2026-07-20 に起動して観測）を根拠にしている。一方、本書や `shared/statusline.ts` 等が参照する
  statusLine スキーマ検証の v2.1.215 は `~/.claude/statusline-cache.json` に残る payload の
  originating build 由来であり、観測源が異なる（前日 2026-07-19 に capture されたキャッシュ）。
  両者は別ソースの実測値であり、片方が他方に対するアップグレード/ダウングレードを意味しない。

## TD-2: ペイン内セッション切替（/clear・/resume）と目的の引き継ぎ

**決定**: **引き継ぐ**。目的は spec §4.6 の第一級エンティティ（`purposes` テーブル）であり、
1ペインは active な目的の下に「セッション列」を持つ。

- statusLine で session_id / transcript_path の変化を検知したら、旧セッション行を閉じ、
  新セッション行を作る。
- 新セッション行はペインの **active な purpose に紐付け**（`purpose_id`）、
  purpose の text・title を `sessions.purpose` / `sessions.title` に非正規化コピーする。
  ハーネス素材として「この一連の作業の目的」が全セッションに残ることを優先。
- `sessions.origin`: `dialog`（目的入力ダイアログ起点）/ `clear` / `resume` /
  `restart`（再起動後のワンクリック再開、TD-7）。
- **/resume で既知の session_id に戻った場合**: 既存行を再オープン（`ended_at = NULL`）し、
  アーカイブは同ファイルへの追記監視を再開する（append-only は維持される）。

## TD-3: ended_at の確定（spec §5）

**決定**: 3経路で閉じる。
1. **pty プロセス終了** → そのペインの open セッションを閉じる
2. **session_id の変化検知**（statusLine 経由）→ 旧セッションを閉じる
3. **アプリ終了時** → 全 open セッションを閉じる（graceful shutdown フック）

`ended_at` の値は検知時刻ではなく、**そのセッションで最後に観測した活動時刻**
（最終 JSONL 追記時刻 or 最終 statusLine 受信時刻の遅い方）。
アプリがクラッシュした場合、次回起動時に open のまま残った行を同ルールで閉じる（修復処理）。

## TD-4: statusLine フォワーダとチェーン（spec §4.3）

**決定**:
- フォワーダは **Node スクリプト**（`node <app>/resources/statusline-forwarder.js`）。
  Node は開発環境に存在する前提（v24 確認済み）。パッケージ配布時は
  `ELECTRON_RUN_AS_NODE=1` での自己バイナリ利用を検討（M5 以降）。
- 動作: stdin の JSON を
  1. 名前付きパイプ `\\.\pipe\cockpit-<app instance id>` へ **fire-and-forget** 送信。
     接続タイムアウト **200ms**。アプリ不在・パイプ断でも**絶対に claude をブロックしない**。
  2. ユーザーの元 statusLine コマンドがあれば同じ stdin を渡して起動し、stdout を素通し
     （端末内の表示を維持）。なければ何も出力しない。
- ペイン識別: アプリ生成 settings に環境変数 or 引数でペイン番号を埋め込み、
  フォワーダがペイロードに `pane` を付与して転送する。
- チェーン元の取得: セッション起動時に `~/.claude/settings.json` の `statusLine` を
  スナップショットし、アプリ生成 settings ファイル内に埋め込む（動的 merge はしない。
  起動後にユーザーが設定を変えても当該セッション中は起動時点の設定を維持）。
- パイプのプロトコル: **JSON Lines**（1メッセージ1行）。パーサは未知フィールド無視・欠落許容。

## TD-5: Windows での claude CLI spawn（node-pty / ConPTY）

**決定**:
- 実体解決ロジックを `main/pty/resolveClaude.ts` に隔離。`where claude` 相当で探索し、
  - `.exe` → 直接 spawn
  - `.cmd`（npm shim）→ `cmd.exe /c <path>` 経由で spawn
- `app_settings.claude_path` で手動上書き可能（解決失敗時の UI 導線もここに接続）。
- 起動引数: `--settings <アプリ生成settings絶対パス>`、cwd = ペインのデフォルトフォルダ。
- リサイズはペインの xterm.js の cols/rows 変化を pty の `resize()` に必ず伝播する。

## TD-6: その他（軽微・実装エージェント裁量の枠）

- ビルドツール: electron-vite を推奨（renderer/preload/main の三点ビルドが素直）。同等品可。
- アーカイブ先: `app.getPath('userData')/archive/<session_id>/`（JSONL＋メタデータ JSON 併置）。
  ※ 2026-07-20 の spec 改訂（§4.4.1、M6）でこれは「一次保存（スプール）」と位置づけられ、
  別途ユーザー設定可能な出力先へのミラーが追加された。詳細は `docs/adr/0008-archive-mirror.md`。
- SQLite DB: `app.getPath('userData')/cockpit.db`。マイグレーションは起動時 idempotent DDL。
- IPC channel 命名: `cockpit:<domain>:<verb>`（例 `cockpit:pty:write`）。`shared/ipc.ts` に集約。
- M5 過去セッション閲覧の表示上限（`main/archive/archiveReader.ts` の `MAX_DISPLAY_TURNS`、
  最新側を残し古い turn を切り詰め）は、**閲覧 UI が1回のレスポンスで返す/表示する件数の省略**に
  過ぎない。アーカイブ本体（`transcript.jsonl` 実体・`sessions` テーブル・メタデータ）は
  spec §4.4 のとおり完全・不変のまま保持され、この上限によって削減・間引きされることはない
  （省略された分は `truncated`/`omittedCount` として明示され、UI が通知する。silent truncation ではない）。

## TD-7: 目的ライフサイクルと再起動復帰（spec §4.6）

**決定**:
- 目的の完了は**ペインヘッダの「完了」操作のみ**で行う（自動判定しない）。
  完了時に `purposes.status = 'completed'`、`completed_at` を記録。
- アプリ終了時、active な目的はそのまま DB に残す（特別な保存処理は不要。
  graceful shutdown で open セッションを閉じるのは TD-3 の責務）。
- **再起動後**: active な目的を持つペインは、目的タイトル＋「再開」ボタンを表示する
  （claude は自動起動しない）。押下で同 cwd・`--continue` 付きで claude を起動し、
  新セッション行を `origin='restart'`・同 `purpose_id` で作成する。
- `--continue` は「その cwd の直近の会話」を復元する仕様のため、cwd が purpose の
  ライフタイム中に変わらないことが前提。ペインのデフォルトフォルダ変更は
  active な目的があるペインでは警告を出す。

