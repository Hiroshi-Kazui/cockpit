# cockpit レビュー品質基準（rubric）

全レビュアー共通の評価軸と、オーケストレータが機械的に読む **verdict スキーマ**。
このファイルが品質ゲートの唯一の基準。閾値の変更はここだけで行う。

## 合格ゲート（マイルストーン前進の条件）

次を **すべて** 満たしたときのみ次マイルストーンへ進む。

1. `tsc --noEmit` エラー 0、`eslint` エラー 0
2. 該当マイルストーンの unit / E2E テストが green
3. 4レビュアー全員が `status: PASS`（= blocking issue が 0）
4. 各レビュアーの `score >= 85`

いずれか未達なら FAIL。blocking issue を実装エージェントへ差し戻し、再実装 → 再レビュー。
**最大 5 反復**。5 反復で合格しない場合は停止し、残存 blocking をユーザーへ報告する。

## 重大度定義

- **blocking**: 仕様違反・不変条件違反・クラッシュ・セキュリティ欠陥・データ破壊・
  プロセス境界違反・silent failure。1件でも PASS 不可。
- **major**: 設計の歪み・保守性の重大な低下・テスト不足。score を大きく下げる。合計で 85 未満なら FAIL。
- **minor**: 命名・軽微な重複・磨き込み余地。score を軽く下げる。単独では FAIL にしない。

## verdict スキーマ（各レビュアーが末尾に必ず出力）

```
=== VERDICT ===
reviewer: <code|architect|usability|requirements>
milestone: <M1..M5>
status: PASS | FAIL
score: <0-100>
blocking:
  - [<severity>] <path>:<line> — <問題> — 必要な修正: <指示>
non_blocking:
  - [<severity>] <path>:<line> — <問題> — 提案: <改善>
summary: <1-2文の総評>
=== END VERDICT ===
```

blocking が空配列なら `status: PASS`。1件でもあれば `status: FAIL`。
オーケストレータは `status` と `blocking` 行だけをパースして次アクションを決める。

## レビュアー別の重点（詳細は各 agent 定義）

- **code-reviewer**: 正確性・型安全・エラー処理・セキュリティ（Electron の
  nodeIntegration/contextIsolation, IPC 検証, パス trav, コマンド注入）・パーサの寛容性・テスト。
- **architect**: プロセス境界、レイヤリング、IPC 契約の型付け、副作用の集約、
  append-only 不変条件、モジュール結合度、拡張性（JSONL/statusLine のバージョン追従）。
- **usability**: CLI UX の無損失素通し、レイアウト切替、目的入力フロー、
  トークン/残量可視化の分かりやすさ、エラー時の見え方、キーボード操作、応答性。
- **requirements**: spec の各節（§4 機能要件, §5 データモデル, §6 該当 M の受け入れ基準）に対する
  逐条トレース。未実装・部分実装・仕様逸脱を blocking で列挙。
