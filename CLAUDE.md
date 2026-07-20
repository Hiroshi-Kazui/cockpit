# cockpit — claude-multi マルチウィンドウ claude-cli マネージャ

## プロジェクト概要

`docs/claude-multi-window-spec.md` が唯一の要件・設計の source of truth（**システムの現在の姿**を記述。変更履歴は持たない）。
spec が実装に委ねた判断は `docs/adr/`（ADR-0008〜）と `docs/technical-decisions.md`（TD-1〜7、凍結）で確定。
マイルストーンごとの受け入れ基準は `milestones/<Mn>-<slug>/acceptance.md`（M1〜M5 のみ `docs/harness/acceptance-criteria.md` に凍結）。
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

## マイルストーン（変更の単位）

マイルストーンの一覧は本ファイルでも spec でも管理しない（二重管理の禁止）。

- **変更の単位は `milestones/<Mn>-<slug>/`**: plan.md（起案・設計判断、`status: draft|approved|shipped`）
  ＋ acceptance.md（受け入れ基準 = レビュアーの逐条トレース対象）
  ＋ followups.md（ビルドループ終了時に残った non_blocking の残課題。次回 `/cockpit-plan` が参照）
- **フロー**: `/cockpit-plan <要件>`（起案・自動採番）→ `/cockpit-build <Mn>`（起動 = plan 承認。
  合格で `status: shipped` ＋ spec を現在形に更新）
- 技術決定は `docs/adr/`（1決定1ファイル。TD-1〜7 は `docs/technical-decisions.md` に凍結）
- 初期建設 M1〜M5 は出荷済み。記録は `docs/harness/acceptance-criteria.md`（凍結）・
  `docs/harness/log/`・git 履歴にある

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
- `shared/` の純関数・契約は **test-first**（実装前にテストを書き、red を確認してから green にする）。
  副作用層（main/renderer）には義務づけない。
