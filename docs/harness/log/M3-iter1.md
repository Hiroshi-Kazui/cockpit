# M3 — 反復1 記録

- 日付: 2026-07-19
- 実装: cockpit-implementer（初回 IMPLEMENT M3、訂正済み §4.5＝コンテキスト消費量ゲージ準拠）
- 静的ゲート（オーケストレータ実測）: tsc.node=0 / tsc.web=0 / eslint=0 / vitest 161/161 pass、実 setInterval() 呼び出し 0 — green

## 主な新規/変更ファイル
shared/{usage.ts,oauthUsage.ts}(+test), ipc.ts,
main/telemetry/{usageCoordinator.ts,usageFallbackScheduler.ts,oauthUsageClient.ts}(+test),
main/db/usageSettingsRepo.ts, main/{index.ts,ipc/handlers.ts},
renderer/src/components/{ContextGauge.tsx,StatusBar.tsx}, hooks/{usePaneContextUsage,useRateLimitsDisplay,useUsageSettings}.ts,
renderer/src/{Pane.tsx,App.tsx,styles.css}, preload/index.ts

## verdict 要約
| reviewer | status | score | blocking |
|---|---|---|---|
| code | PASS | 92 | 0 |
| architect | PASS | 92 | 0 |
| usability | PASS | 88 | 0 |
| requirements | PASS | 92 | 0 |

## ゲート判定
全員 PASS・score≥85・静的ゲート green → **ゲート条件は充足**。

## blocking ではないが重要な major（反復2 で対応推奨）
1. [major][usability] ContextGauge.tsx — 常時可視ラベルが `context` のみで「compactまでの目安」がホバー title 止まり。**過去にユーザーが累計トークンと誤読した点の再発リスク**。モックどおり `context（compactまで）`＋常時 `残り {100-pct}%` を可視化すべき。
2. [major][requirements] statusline.ts — statusLine の context/rate_limits フィールド名が実ペイロード未検証。AC #1/#3 の end-to-end 未確認（寛容パーサで安全 degrade するが measured 経路が点灯しない可能性）。実 claude 出力1件のキャプチャで確定が必要。
3. [major][requirements] StatusBar/usage — `resets_at` を number(ms) 前提で扱うが実値の単位（epoch秒/ISO文字列）未検証。秒/ISO ならリセット残り時間が誤表示。実値で単位確認し ms 正規化。

## non-blocking minor
- DRY 漏れ: StatusBar が isEstimatedDisplay を、ContextGauge が clampPercentage を inline 再実装（純関数が既存、architect）
- 残量ゲージ色が measured/estimated を符号化し危険度（枯渇間近＝赤）を符号化しない（usability）
- .context-gauge__label が #9d9d9d でコントラスト方針（#b8b8b8）と不整合（usability）
- credential パス未検証 / parseStoredNumber の正値強制 / custom 入力の無反応破棄（code）

## 最終判定
反復1: ゲート充足（合格ライン）。ただし usability major（誤読再発）＋ requirements major（実ペイロード未検証・resets_at 単位）が残るため、ユーザーに反復2（FIX）実施を推奨・判断を仰ぐ。
