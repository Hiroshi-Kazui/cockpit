# M3 — 反復4 記録（磨き込み収束：課題ゼロ到達）

- 日付: 2026-07-19
- 契機: ユーザー指示「課題がなくなるまで修正の反復を続けよ。これまでのワークフロー通り」
- 実装: cockpit-implementer（FIX モード、残 trivial minor 2件）
- 静的ゲート（オーケストレータ実測）: tsc.node=0 / tsc.web=0 / eslint=0 / vitest 189/189 pass — green
- レビュー: code / architect / requirements の3体（UI サーフェス変更なしのため usability 省略）

## 変更ファイル
- src/shared/statusline.ts — `*_KEYS`（USED_PERCENTAGE/RESETS_AT/RATE_LIMITS/FIVE_HOUR/SEVEN_DAY ＋ CONTEXT_* 非export）に `as const`（readonly タプル化）、`isRecord` を export 一本化
- src/shared/oauthUsage.ts — ローカル `isRecord` 削除、statusline から import 再利用

## 解消した minor
1. [code] `*_KEYS` が mutable な `string[]` で export → `as const` で readonly タプル化（外部変異を型で封じる）。call site は全て read-only、挙動不変。
2. [architect] `isRecord` の statusline↔oauthUsage 重複 → statusline.ts へ一本化 export＋oauthUsage 再利用。依存方向 oauthUsage→statusline は一方向・非循環維持。新モジュールは作らず（YAGNI 準拠、3件目の消費者で parseHelpers.ts へ抽出が将来の分割線）。

## verdict 要約（全員 指摘ゼロ）
| reviewer | status | score | non-blocking |
|---|---|---|---|
| code | PASS | 99 | なし |
| architect | PASS | 98 | なし |
| requirements | PASS | 98 | なし |

## 収束判定
3体とも「closable な課題は無く収束した」と明言。`jsonl.ts` の独立 `isRecord` は「他モジュールと結合しない自己完結の trivial guard」として3体が意図的に許容（強制集約は statusline をハブ化し依存方向を劣化させるため害）。

## 唯一の未クローズ事項（原理的に closable でない環境制約）
- **empty/absent rate_limits の live 実キャプチャ**: この環境のアカウントは常に rate_limits が populate されるため、欠落 payload をオンデマンド生成できない（サーバ側がフィールドを省略した時のみ発生）。実装の欠陥ではなく実証サンプルの欠落。absence 起点の synthetic 純関数テスト（rateLimits 全null / 片窓null / used_percentage null → 推定＋「推定」バッジ）で担保済み。doc に「実アカウント未検証・環境制約」と誤主張なく明記。

## 最終判定
**M3 は課題ゼロに収束**（3体全員 PASS・指摘ゼロ・静的ゲート green、vitest 189/189）。残るは上記の原理的に closable でない環境制約1点のみ（synthetic テストで代替済み・明示区別済み）。反復数: M3 通算 iter1〜4（合格 iter2、追加ハードニング iter3、磨き込み収束 iter4）。
