# cockpit — claude-multi マルチウィンドウ claude-cli マネージャ

## プロジェクト概要

`docs/claude-multi-window-spec.md` が唯一の要件・設計の source of truth。
spec が実装に委ねた判断は `docs/technical-decisions.md`（TD-1〜TD-6）で確定済み。
マイルストーンごとの受け入れ基準は `docs/harness/acceptance-criteria.md`。
claude CLI を最大4ペインで並行起動し、セッションのやり取りを append-only で
アーカイブするデスクトップアプリ。責務は「起動・表示・記録」に限定する。

## 技術スタック（固定）

- **Electron + TypeScript**（strict モード）
- Renderer: **React + xterm.js**（生 pty 入出力の素通し。キーストロークを横取りしない）
- Main: **node-pty**（claude CLI 起動）, **chokidar**（JSONL 監視）
- ストレージ: **better-sqlite3**（メタデータ index）＋ FS（JSONL アーカイブ本体）
- タイトル生成: `claude -p --model haiku` のヘッドレス1ショット
- テスト: **vitest**（unit）, **@playwright/test** with Electron（E2E）
- Lint/format: **eslint** + **prettier**、型は `tsc --noEmit` で CI ゲート

## 環境固有の制約（Windows / 実装環境）

- **OS は Windows 11**。IPC は Unix ソケットではなく**名前付きパイプ** `\\.\pipe\cockpit-<id>` を使う。
  spec の「Unixソケット／名前付きパイプ」は本環境では名前付きパイプで実装する。
- **ネイティブモジュール**（node-pty, better-sqlite3）は Electron の ABI に合わせて
  `electron-rebuild`（または `@electron/rebuild`）でリビルドが必須。CI・セットアップ手順に含める。
- パス操作は必ず `path` API 経由。文字列連結でパスを組まない（Windows のバックスラッシュ）。
- bash からパスを扱う場合は `C:/...` 形式。`C:\...` は解釈されない。

## アーキテクチャ原則（architect レビューの評価軸）

- **プロセス境界の明確化**: Main（特権・pty・FS・DB）/ Renderer（UI のみ）/ Preload（contextBridge の最小 API）。
  Renderer から Node API へ直接触らせない（`nodeIntegration: false`, `contextIsolation: true`）。
- **IPC は型付き契約**: channel 名と payload 型を1箇所で定義し main/preload/renderer で共有。
- **パーサは寛容**: JSONL・statusLine JSON は未知フィールドを無視し、欠落を許容（spec §7）。
  パーサは純関数として切り出し、単体テスト可能にする。
- **append-only 不変条件**: アーカイブに削除・編集経路を作らない。元 JSONL は決して書き換えない。
- **副作用の集約**: DB 書き込み・FS・pty 起動は専用モジュールに閉じ込め、UI ロジックと混ぜない。
- レイヤ: `main/`（pty, ipc, db, archiver, telemetry）/ `renderer/`（components, hooks, state）/
  `preload/` / `shared/`（型・契約・純パーサ）。

## マイルストーン（spec §6）

- **M1**: Electron シェル、4ペイングリッド、node-pty 起動、デフォルトフォルダ永続化
- **M2**: JSONL 検出・紐付け・アーカイブ同期、セッションメタデータ保存
- **M3**: ペイン内コンテキスト消費量ゲージ（compact目安・緑→オレンジ→赤）、累計トークンはメタデータ記録、ステータスバー 5h/週次残り（推定）
- **M4**: 目的入力ダイアログ、初回プロンプト自動送信、`claude -p` タイトル生成
- **M5**: 過去セッション一覧・閲覧 UI、レイアウト切替、磨き込み

各マイルストーンは前段の受け入れ基準を満たしてから次へ進む。

## 開発ハーネス（このリポジトリの中核）

実装は Sonnet 実装エージェント、レビューは Opus の4レビュアーで回す。
オーケストレーションは `/cockpit-build <milestone>` コマンド、品質基準は
`docs/harness/review-rubric.md`。詳細は `docs/harness/README.md`。

- `.claude/agents/cockpit-implementer.md` — 実装（sonnet）
- `.claude/agents/cockpit-code-reviewer.md` — コード品質・正確性・セキュリティ（opus）
- `.claude/agents/cockpit-architect.md` — アーキテクチャの美しさ監視（opus）
- `.claude/agents/cockpit-usability-reviewer.md` — UX（opus）
- `.claude/agents/cockpit-requirements-reviewer.md` — 要件充足（opus）

## コーディング規約

- TypeScript strict。`any` 禁止（不可避なら理由コメント）。
- 例外を握り潰さない。失敗は型（Result/例外）で伝播させる（silent failure 禁止）。
- ファイル冒頭に責務を1行コメント。関数は単一責任。
- テストは振る舞いを検証する（実装詳細でなく仕様の受け入れ基準）。
