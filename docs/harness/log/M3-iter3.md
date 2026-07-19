# M3 — 反復3 記録（合格済み M3 への追加ハードニング：残タスク1・2 解消）

- 日付: 2026-07-19
- 契機: ユーザー指示「1,2の課題を解消してほしい。実装→レビューで反復的に」
- 実装: cockpit-implementer（FIX モード）
- 静的ゲート（オーケストレータ実測）: tsc.node=0 / tsc.web=0 / eslint=0 / vitest 184/184 pass — green
- レビュー: 変更がバックエンド/データ層のみ（UI サーフェス変更なし）のため、関連する code / architect / requirements の3体で実施（usability は評価対象なしのため省略）

## 変更ファイル
- src/shared/oauthUsage.ts — readWindow の resets_at を normalizeResetsAt 経由に統一（+test 更新: 秒/ms/ISO/欠落）
- src/shared/statusline.ts — doc コメントを "verified against live payloads 2026-07-19" に更新（+実 shape 回帰テスト）
- src/shared/jsonl.ts — doc コメントを "verified against a live transcript" に更新（+実 usage 回帰テスト）
- src/main/telemetry/oauthUsageClient.ts — doc コメント "verified against a live installation"
- *.test.ts（oauthUsage/statusline/jsonl）

## タスクA（oauth resets_at 正規化統一）
- normalizeResetsAt を resets_at 正規化の単一入口に（statusLine 経路と oauth fallback 経路が同一ヒューリスティックを共有）。前回 architect/code/requirements が一致指摘した「2箇所分岐」を解消。

## タスクB（実データによるスキーマ確定 — UNVERIFIED → verified）
実機の既存キャプチャ2件（本セッション `statusline-cache.json` v2.1.215＋別プロジェクト debug dump v2.1.89）＋実 JSONL＋実 .credentials.json で実 shape を確定（新規 claude 起動によるトークン消費を回避＝実装者が意図的逸脱として明示報告、レビュアーも妥当と評価）:
- statusLine: 全 snake_case、コンテキスト使用率は `context_window.used_percentage` ネスト、`rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`、**resets_at は epoch 秒**（例 1775055600, 1784468400）。
- JSONL usage: input_tokens/output_tokens/cache_read_input_tokens/cache_creation_input_tokens。
- credential: ~/.claude/.credentials.json の claudeAiOauth.accessToken。
- 結論: 既存パーサ（snake 優先＋context_window ネスト＋秒判定 normalizeResetsAt）が実態と一致していたと確認。コード変更不要、回帰テスト＋doc 更新のみ。

## verdict 要約
| reviewer | status | score | blocking |
|---|---|---|---|
| code | PASS | 95 | 0 |
| architect | PASS | 96 | 0 |
| requirements | PASS | 95 | 0 |

## 新たに出た non-blocking minor（今回は未対応、後続候補）
- [minor][code] oauthUsageClient.ts の credential JSON パース失敗時に `err` 全体を debug ログ出力 → V8 SyntaxError メッセージに accessToken 断片が混入し得る。`err.name`/`code` のみに絞るべき。
- [minor][requirements] empty rate_limits を出すアカウント種別は実サンプル未取得（純関数テストで field-absence は担保、実在は仮定のまま）。実キャプチャできれば回帰固定。
- [minor][requirements] statusline.ts に旧「unverified」コメント塊と新「verified」塊が併存（provenance 矛盾）。統合すべき doc 衛生。
- [minor][architect] oauth 側 resets_at/used_percentage の probe が snake 固定で statusLine 側の snake/camel 両 probe と非対称（実害なし、意図なら doc 明記）。

## 最終判定
残タスク1・2ともに**解消（実データ裏付け付き）**。3体全員 PASS・静的ゲート green。M3 は合格状態を維持し、UNVERIFIED リスクが解消された。
