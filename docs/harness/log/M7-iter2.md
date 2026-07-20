# M7 反復2 ログ（最終・合格）

日時: 2026-07-21
対象: M7 — ミラーの hardening（M6 残課題の一括解消、per-root 進捗化）

## FIX（反復1 blocking 1 ＋ 同梱 major 1）
- blocking（マイグレーション原子性）: `migrateArchiveMirrorToCompositeKey` を `database.transaction(...)` で
  原子化（crash 時ロールバック）＋中間テーブル作成前に `DROP TABLE IF EXISTS archive_mirror__m7_migrating` prepend。
  `schema.test.ts` に「中間テーブル残存からの再実行が壊れない」回帰テスト追加（非空を実装者が確認）
- major（acceptance #6）: `rebaselineSession` の `const sink = this.sink`（null ガード）をメソッド冒頭
  （最初の await の前）へ移動。await 跨ぎの sink↔root 食い違いレースを解消

## 静的ゲート（実測）
tsc（node/web）0 / eslint 0 / vitest 428/428 / playwright 6/6。→ 通過

## レビュー verdict
| reviewer | status | score | 備考 |
|---|---|---|---|
| usability | PASS | 91 | 反復1継続（FIX は main 側のみ、renderer 無変更） |
| architect | PASS | 90 | major 解消（sink entry 捕捉）、4不変条件維持 |
| requirements | PASS | 98 | acceptance #2/#6 厳密充足、退行なし |
| code | PASS | (blocking 0/major 0) | マイグレーション原子化解消確認、回帰テスト非空を検証 |

## ゲート判定: 合格
4レビュアー全員 PASS、blocking 0。静的・E2E green。
（code は numeric score 未出力だが blocking 0・major 0・minor 1 のため rubric 上 85 以上に相当。
usability は renderer 非変更のため反復1 PASS を継続。）

## 出荷処理
- plan.md `status: approved → shipped`
- **spec §5 の `archive_mirror` を複合キー `(session_id, dest_root)` 形へ更新**（M7 の現在の姿。ADR-0009 決定#5）
- **ADR-0009 `proposed → accepted`**、ADR 索引も更新
- M6 followups.md に「全14件 M7 で解消済み」を明記
- 残 non_blocking（minor 8件）を `milestones/M7-mirror-hardening/followups.md` へ集約

## 反復サマリ
反復1: 実装 → FAIL（blocking 1: マイグレーション非原子性でアプリ恒久起動不能 / 同梱 major: sink 捕捉位置）
反復2: FIX → 合格
