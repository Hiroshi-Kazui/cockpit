# M11 反復3 — 新規セッション開始時の git 同期

日付: 2026-07-28 / 判定: **PASS（マイルストーン合格・出荷）**

## 静的ゲート（オーケストレータが実測）
`typecheck`（node/web/e2e）exit 0 / `eslint` exit 0 / `vitest run` 656 passed（38 files） /
`playwright test` 8 passed

## verdict サマリ

| reviewer | status | score |
|---|---|---|
| code | PASS | 92 |
| architect | PASS | 92 |
| usability | PASS | 93 |
| requirements | PASS | 92 |

合格条件（blocking 0 かつ 4体すべて score >= 85）を満たした。

## 反復2 blocking の解消
- **B1 「commit を促す」文言の復元** — `gitSync.ts:239-248` に
  「commit してから改めて新規セッションを開始すると、デフォルトブランチへの移動と pull が行われます」が復活し、
  「今回のセッションは現在のブランチのまま開始します」との両立も保たれた。`gitSync.test.ts:265` で
  commit 語の存在を固定。要件原文・spec §4.2・ADR D-9・plan R-3・acceptance R-3 と一致（requirements 確認）
- **B2 FIX M6 の取り下げ** — `planRepoSync` の busy 判定を dirty 直後・無条件ブロックへ復帰
  （`gitSync.ts:188-195`、checkout/pull が1回も実行されないことを `repoSync.test.ts:198` で固定）。
  `block-busy` プランの `requiresSwitch` は **modal を出すか通知行のみか**だけを決める。
  ADR-0013 D-7 は基底文を書き直し、反復1 の改定は「却下した代替案」書式へ格下げ

## 反復2 major の解消
- checkout 済みなのに `skipped` を返す自己矛盾 → `synced{pulled:false, pullSkippedReason}` に統一
- `blocked-busy` に `cause:'running'|'launching'` を追加し文言を出し分け（ロック由来は次アクション付き）
- busy 候補の rev-parse 失敗・空 stdout を安全側（busy）に倒す

## 退行確認（code レビュアーがコードで確認）
- `cwds.delete` は **インスタンス同一性ガード `panes.get(pane) === proc` の内側**にあり、respawn 後に
  旧 proc の exit が遅れて届いても新 cwd を壊さない
- `synced.pullSkippedReason` は必須フィールドで生成箇所5つすべてに存在（tsc が漏れを検出、0 エラー）
- busy 安全側化は「非リポジトリと確定できたときだけ not-busy」で、正常系の過剰ブロックは起きない
- `src/main/git/**` で作業ツリーを変える呼び出しは `['checkout', targetBranch]` と `['pull','--ff-only']` のみ

## 出荷処理（オーケストレータ実施）
1. `plan.md` `status: approved` → `shipped`
2. **plan.md の訂正**（architect / requirements の major）: 反復1 の誤指示 M6 の痕跡が最上流の plan に
   残っていたため、§7 に **U-2**（ブロックは無条件・modal のみ出し分け、経緯を含む）を追記し、
   R-6 / R-8 / D-7 から参照を張った。`acceptance.md` R-8 第2項にも同じ qualifier を追記
3. **spec の実態整合**: §7 の「`pull` は最大 30 秒待たせうる」は、照会・checkout・pull のタイムアウトが
   1回の準備の中で積み上がる実装と合っていなかったため「30 秒を超える」に訂正（数値の誇張を排除）
4. `followups.md` に未解消 non_blocking を集約（major 1 / minor 17）

## 判定
**合格・出荷**。反復3で終了（上限5に対し3反復）。
