# cockpit

**claude CLI を最大4ペインで並行起動し、セッションのやり取りを完全な形で記録・アーカイブする Windows デスクトップアプリ。**

各ペインに独立した claude セッションを持ち、CLI の対話 UX（スラッシュコマンド・権限確認・スキル・フック）を一切損なわずに、全セッションの JSONL を append-only でアーカイブします。収集したログは後日、開発を一任する疑似 AGI ハーネスの構築素材として利用します。責務は「起動・表示・記録」に限定し、会話内容への介入・加工は行いません。

## 主な機能

- **4ペイン並行セッション** — 1 / 2分割 / 4分割レイアウト切替。ペインごとにデフォルトフォルダを永続化し、独立した pty で claude を起動。キー入力・出力は生のまま素通し
- **目的駆動の起動フロー** — 新規セッションで目的を入力（空でも可）すると、初回プロンプトとして自動送信し、`claude -p --model haiku` で約20字のタイトルを生成してペインヘッダに表示。目的は「完了」操作まで `/clear`・`/resume`・アプリ再起動をまたいで継続し、再起動後はワンクリックで `--continue` 再開
- **完全アーカイブ（append-only）** — statusLine テレメトリでセッション JSONL を自動検出し、アプリ管理領域へ追記同期。メタデータ（目的・タイトル・cwd・使用モデル・累計トークン等）を併置し、SQLite にインデックス。削除・編集の経路は存在しない
- **アーカイブ出力先の設定（クラウドミラー）** — 一次保存（スプール）とは別に、任意のフォルダへ非同期ミラーできる。Google Drive for Desktop / OneDrive / Dropbox 等の同期フォルダを指定すればクラウド保存になる。出力先がオフラインでも記録は途切れず、復旧後に追い付く（結果整合）。過去セッションの一括バックフィルも明示操作で可能
- **使用量の可視化** — ペインごとにコンテキスト消費ゲージ（緑→オレンジ→赤、compact までの目安）。ステータスバーに 5時間 / 週次レート制限の残り%（Anthropic サーバ実測値。取得不能時はローカル集計による推定表示に自動切替）
- **過去セッションの検索・閲覧** — アーカイブ済みセッションの一覧・読み取り専用ビューア

## クイックスタート（Windows）

**`cockpit-start.vbs` をダブルクリック**するだけで起動します。

- 初回はセットアップ（`npm install --ignore-scripts && npm run setup`）を自動実行してから起動します（数分かかります）
- コンソールウィンドウは表示されません。失敗時のみダイアログでエラーを通知します
- ショートカットをデスクトップ等に作って構いません（スクリプトは自身の場所を作業ディレクトリに解決します）

前提ソフトウェア（初回セットアップに必要）:

- **Node.js** v20+（動作確認は v24）
- **Python 3**（node-gyp のビルドに使用）
- **Visual Studio Build Tools 2022**（"Desktop development with C++" ワークロード。node-pty / better-sqlite3 のネイティブビルドに必要）
- **claude CLI**（PATH 上にあること。解決の詳細は後述）

## 手動セットアップ

```sh
npm install --ignore-scripts
npm run setup
```

`--ignore-scripts` が必要な理由: `better-sqlite3` は自身の `install` スクリプト
（`prebuild-install || node-gyp rebuild --release`）で **Node ABI 向け**のビルドを
自動実行しようとするが、これは不要（本アプリは Electron ABI でのみ実行するため）かつ、
Node の新しいバージョンでは prebuild が存在せずローカルビルドにフォールバックし、
環境によっては npm 同梱の node-gyp が VS2022 の Utility ターゲット（`type: 'none'`）に対して
`PlatformToolset` を解決できず `MSB8020` で失敗することが確認されている。

`--ignore-scripts` は `electron` パッケージ自身の `postinstall`（Electron バイナリ本体のダウンロード）
もスキップしてしまうため、`npm run setup` が

1. `node node_modules/electron/install.js` で Electron バイナリを取得し、
2. `npm run rebuild`（`patch-package` で `node-pty` の `SpectreMitigation` 設定パッチ、下記参照、を適用した上で
   `@electron/rebuild` により **Electron の ABI に向けて直接** `better-sqlite3`/`node-pty` をビルド）

を順に実行する。この経路では上記の `MSB8020` 問題は再現しない（`@electron/node-gyp` が正しく
`v143` ツールセットを解決するため）。

Electron のバージョンを変更した場合や、ネイティブモジュールの動作がおかしい場合は再実行できます:

```sh
npm run rebuild
```

### 既知の環境依存の問題と対処（Windows）

- **node-pty のネイティブビルドが Spectre 軽減ライブラリを要求する**:
  `node-pty`（および同梱の `winpty`）の `binding.gyp` は既定で
  `SpectreMitigation: 'Spectre'` を要求するが、これには Visual Studio Installer の
  「Spectre 軽減済みライブラリ」個別コンポーネント（管理者権限でのインストールが必要）が要る。
  本リポジトリは `patches/node-pty+1.1.0.patch`（`patch-package` で `postinstall`/`npm run rebuild`
  時に自動適用）で `SpectreMitigation: 'false'` に緩和し、追加コンポーネント無しでビルドできるようにしている。
- **`NoDefaultCurrentDirectoryInExePath=1` が環境変数に設定されている場合**（一部のセキュリティ強化された
  Windows 環境）、`node-pty` の `winpty` 依存が使う `cmd /c "cd shared && GetCommitHash.bat"` 形式の
  gyp アクションが「ファイルが見つかりません」で失敗する（cmd.exe がカレントディレクトリを実行ファイル
  探索対象から除外するため）。`npm run rebuild` はこの変数をコマンド実行時のみ空にして起動するため
  影響を受けない。

## 開発

```sh
npm run dev
```

electron-vite の dev サーバーが renderer(Vite HMR) + main/preload(esbuild watch) を起動し、
Electron ウィンドウが立ち上がります。

### 品質ゲート

```sh
npm run typecheck    # tsc --noEmit (main/preload + renderer)
npm run lint         # eslint .
npm test             # vitest run（unit）
npm run test:e2e     # electron-vite build && playwright test（E2E）
npm run build        # electron-vite build
```

## claude CLI の実体解決

起動時に `where claude` で PATH 上の claude CLI を探索します。`.exe` は直接 spawn、
npm インストール由来の `.cmd` シムは `cmd.exe /c` 経由で spawn します
（`src/main/pty/resolveClaude.ts`）。

自動解決に失敗した場合、またはインストール先を明示したい場合は、アプリ内で
`app_settings.claude_path` に絶対パスを設定することで上書きできます
（`cockpit:appSettings:setClaudePath` IPC、`src/main/db/appSettingsRepo.ts`）。
解決に失敗すると起動時のバナーおよびペインの「claude 起動」失敗時にエラーメッセージが表示されます
（silent failure なし）。

## データの保存場所

- **スプール（一次保存）**: `%APPDATA%/cockpit/archive/<session_id>/`（`transcript.jsonl` + `metadata.json`）。記録の完全性はここで担保
- **メタデータ DB**: `%APPDATA%/cockpit/cockpit.db`（SQLite。常にローカル固定 — クラウド同期フォルダには置けない）
- **ミラー出力先（任意）**: アプリ内「アーカイブ出力先」で設定したフォルダ。スプールと同一のディレクトリ構造で非同期複製される

## ディレクトリ構成

```
src/
  main/       # Electron main process: pty, db, ipc, archive/mirror (副作用はここに閉じ込める)
  preload/    # contextBridge 経由の最小 API のみ公開
  renderer/   # React + xterm.js UI (Node/Electron API に直接触れない)
  shared/     # main/preload/renderer 共有の型・IPC契約・純関数（パーサ等）
e2e/          # Playwright + Electron の E2E テスト
docs/         # 仕様・技術決定・開発ハーネス
milestones/   # 変更単位（起案プラン・受け入れ基準・残課題）
```

## ドキュメント案内

| 文書 | 役割 |
|---|---|
| `docs/claude-multi-window-spec.md` | 要件・設計の source of truth（**システムの現在の姿**。変更履歴は持たない） |
| `milestones/<Mn>-<slug>/` | 変更の単位。plan.md（起案・設計判断・承認状態）+ acceptance.md（受け入れ基準）+ followups.md（残課題） |
| `docs/adr/` | 技術決定記録（1決定1ファイル。索引は `docs/adr/README.md`） |
| `docs/technical-decisions.md` | 初期建設期の技術決定 TD-1〜7（凍結） |
| `docs/harness/` | 開発ハーネス（レビュー品質基準・受け入れ基準 M1〜M5 凍結版・反復ログ） |

## 開発ワークフロー（Claude Code ハーネス）

本リポジトリは、実装を Sonnet 実装エージェント・レビューを Opus 4体（コード品質 / アーキテクチャ / UX / 要件充足）で回す自動ループで開発されています。

```
/cockpit-plan <要件>     # 起案: milestones/<Mn>/ を自動採番で作成（プラン+受け入れ基準）
/cockpit-build <Mn>      # 実装: 起動 = プラン承認。実装→4体レビュー→fix を品質ゲート合格まで反復
```

品質ゲート: 静的検査（tsc / eslint / vitest / playwright）全緑 + 4レビュアー全員 PASS（blocking 0 かつ score ≥ 85）。合格で spec を現在の姿に更新し、未解消の指摘は followups.md へ集約されます。詳細は `docs/harness/README.md`。
