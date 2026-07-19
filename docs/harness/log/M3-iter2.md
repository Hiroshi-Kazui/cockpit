# M3 — 反復2 記録（FIX → 合格）

- 日付: 2026-07-19
- 実装: cockpit-implementer（FIX モード、反復1の major 3件＋minor 対応。ユーザーが反復2実施を選択）
- 静的ゲート（オーケストレータ実測）: tsc.node=0 / tsc.web=0 / eslint=0 / vitest 179/179 pass、実 setInterval() 0 — green

## 変更ファイル（FIX 差分）
- src/shared/statusline.ts — normalizeResetsAt（秒/ms/ISO→ms 正規化）＋フィールド名候補の snake/camel 防御拡張（+test）
- src/shared/usage.ts — remainingPercentageColor（≥50緑/25-49橙/<25赤）（+test）
- src/renderer/src/components/ContextGauge.tsx — ラベル「context（compactまで）」常時可視＋常時「残り N%」、clampPercentage 再利用
- src/renderer/src/components/StatusBar.tsx — isEstimatedDisplay 再利用、残量ゲージを危険度段階色、custom 入力検証メッセージ
- src/renderer/src/styles.css — ゲージラベル文言/残り%、残量色、.context-gauge__label コントラスト #b8b8b8
- src/main/db/usageSettingsRepo.ts — parseStoredNumber の n>0 強制
- src/main/telemetry/oauthUsageClient.ts — credential 読み取り ENOENT/異常の判別ログ
- src/main/telemetry/usageCoordinator.test.ts — resets_at 正規化に伴う fixture 修正

## verdict 要約
| reviewer | status | score | blocking |
|---|---|---|---|
| code | PASS | 93 | 0 |
| architect | PASS | 93 | 0 |
| usability | PASS | 93 | 0 |
| requirements | PASS | 90 | 0 |

## 反復1 major の解消確認
1. [解消] ゲージ誤読リスク → 常時 `context（compactまで）`＋`残り N%`、累計トークンは .pane-telemetry に分離。usability が「誤読の根本原因（裸の context ラベル）除去」を実挙動で確認。
2. [primary 解消] resets_at 単位 → normalizeResetsAt（秒<10^12→×1000 / ms / ISO / 不正→null）。statusLine 経路は正規化済み。
3. [軽減] statusLine フィールド名 → snake/camel＋ネスト候補の防御拡張＋optional-safe。ただし live payload での確定は環境制約で未実施（UNVERIFIED、残存リスク）。

## 残存 non-blocking（後続で対応推奨）
- **[major, 非blocking] oauthUsage.ts の resets_at が normalizeResetsAt を未経由**（code/architect/requirements の3体が一致指摘）。fallback フェッチ経路のみ、秒を返す場合 reset 時刻が「0分後」に有界劣化（クラッシュ/1000x 誤表示なし、usedPercentage は正常）。**1行修正で統一可能**（readWindow の resets_at を normalizeResetsAt 経由に）。
- **[major, 非blocking] statusLine/credential の実 claude 出力での最終確定が未実施**（環境に生きた claude セッションが無いため）。寛容パーサ＋推定フォールバックで安全 degrade。実機検証は残タスク。
- [minor] statusline.ts のコメント西暦誤記（コード無影響）、setUsageSettings 書き込み側の正値検証、ステータスバー補助テキストのコントラスト、残り% フォントサイズ 9px。

## 最終判定
**M3 合格**（4レビュアー全員 PASS・score≥85・静的ゲート green）。反復数: 2。
次マイルストーン（M4）へは自動で進まず、ユーザー指示を待つ。
