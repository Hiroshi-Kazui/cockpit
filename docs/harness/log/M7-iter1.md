# M7 反復1 ログ

日時: 2026-07-21
対象: M7 — ミラーの hardening（M6 残課題の一括解消、per-root 進捗化）

## 実装（cockpit-implementer）
`archive_mirror` 複合キー化＋起動時 idempotent マイグレーション、A→B→A 完全 resume
（`computeResumeVerificationRange`）、sentinel/transient 区別、bytesRead 検証、i18n、
UX（解除説明・opener フォーカス・backfill 即時フィードバック・コントラスト）、
構造（useMirrorStatus 単一購読・status push 集約・computeBackfillPlan 抽出）。followups 14件対応。

## 静的ゲート（オーケストレータ実測）
tsc（node/web）0 / eslint 0 / vitest 427/427。→ 通過

## レビュー verdict
| reviewer | status | score |
|---|---|---|
| usability | PASS | 91 |
| requirements | PASS | 96 |
| architect | PASS | 88 |
| code | FAIL | 80 |

acceptance 21項目・followups 14件は requirements が一対一で解消確認。スコープ外の先取りなし。

## 集約 blocking（FIX 対象）
1. **[blocking] マイグレーションが非トランザクション＋`DROP IF EXISTS` ガードなし** — `schema.ts:42-59` + `db.ts:18`。
   `CREATE / INSERT SELECT / DROP / RENAME` の4文が autocommit で個別コミットされ、CREATE と DROP の間で
   クラッシュすると中間テーブル `archive_mirror__m7_migrating` が残存。旧 `archive_mirror` は単一 PK のまま残るため
   次回起動で `needsArchiveMirrorMigration` が再度 true → `CREATE TABLE`（IF NOT EXISTS なし）が
   「table already exists」で throw → `migrate()`/`getDb()` throw → **アプリ恒久起動不能**（決定論的）。
   実装者の FakeDatabase 検証はトランザクション・原子性・部分適用を一切モデルせず、この中断特性を死角にしている。
   （code 検出）

## FIX に同梱する major（acceptance #6 を閉じ切るため）
2. **[major] `rebaselineSession` の sink 捕捉が最初の await の後** — `mirrorCoordinator.ts:208-211`。
   `const sink = this.sink` が `statSpoolTranscript` の await を跨いだ後に捕捉されるため、await 中に
   `setOutputRoot` が別 root へ切替わると sink（新root）と root 引数（旧root）が食い違う残余レース
   （派生 DB 行のみ・自己修復・データ安全）。acceptance #6「メソッド冒頭で捕捉」の文言が厳密には未達。
   捕捉を await の前（method entry）へ移すだけで解消。（architect 検出、major。FIX で同時是正）

## 判定: FAIL → 反復2（FIX）へ
non_blocking（backfill 外側 catch の error 握り潰し、英語 throw 文言、retryTimers キー等）は
ゲート終了時に followups.md へ。
