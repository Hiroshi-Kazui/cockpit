# cockpit

claude CLI を最大4ペインで並行起動し、セッションのやり取りを記録するデスクトップアプリ。
詳細は `docs/claude-multi-window-spec.md`、確定判断は `docs/technical-decisions.md` を参照。

## セットアップ（Windows）

前提:
- Node.js（v20+ 推奨。動作確認は v24）
- Python 3（node-gyp のビルドに使用）
- Visual Studio Build Tools 2022（"Desktop development with C++" ワークロード。
  node-pty / better-sqlite3 のネイティブビルドに必要）

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

## claude CLI の実体解決（TD-5）

起動時に `where claude` で PATH 上の claude CLI を探索します。`.exe` は直接 spawn、
npm インストール由来の `.cmd` シムは `cmd.exe /c` 経由で spawn します
（`src/main/pty/resolveClaude.ts`）。

自動解決に失敗した場合、またはインストール先を明示したい場合は、アプリ内で
`app_settings.claude_path` に絶対パスを設定することで上書きできます
（`cockpit:appSettings:setClaudePath` IPC、`src/main/db/appSettingsRepo.ts`）。
解決に失敗すると起動時のバナーおよびペインの「claude 起動」失敗時にエラーメッセージが表示されます
（silent failure なし）。

## 品質ゲート

```sh
npm run typecheck   # tsc --noEmit (main/preload + renderer)
npm run lint         # eslint .
npm test             # vitest run
npm run build        # electron-vite build
```

## ディレクトリ構成

```
src/
  main/       # Electron main process: pty, db, ipc (副作用はここに閉じ込める)
  preload/    # contextBridge 経由の最小 API のみ公開
  renderer/   # React + xterm.js UI (Node/Electron API に直接触れない)
  shared/     # main/preload/renderer 共有の型・IPC契約・純関数（パーサ等）
```
