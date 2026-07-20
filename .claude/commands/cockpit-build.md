---
description: cockpit をマイルストーン単位で「Sonnet実装→Opus4レビュー→fix」ループで品質ゲート合格まで自動構築する。起動 = 対象マイルストーンの plan 承認
argument-hint: <Mn>（例: M6。事前に /cockpit-plan で milestones/<Mn>-*/ が起案済みであること）
---

# /cockpit-build — cockpit 開発オーケストレータ

あなた（メインスレッド）は**指揮者**。自分でアプリコードは書かず、実装は
`cockpit-implementer`（sonnet）、レビューは4体の opus レビュアーに委ね、
品質ゲート合格までループを回す。

対象マイルストーン: **$ARGUMENTS**（未指定なら M1）

## 前提の読み込み（最初に必ず）
1. **`milestones/<Mn>-*/`**（変更の単位）: `plan.md`（設計判断・実装フェーズ）と
   `acceptance.md`（この増分の受け入れ基準 = requirements-reviewer の逐条トレース対象、
   implementer の実装スコープ定義）
   （初期建設 M1〜M5 のみ例外: `docs/harness/acceptance-criteria.md` の該当節を使う）
2. `docs/claude-multi-window-spec.md`（システムの現在の姿。既存不変条件の正）
3. plan.md の `decisions:` が指す ADR ＋ `docs/technical-decisions.md`（TD-1〜7 凍結分）
4. `docs/harness/review-rubric.md`（合格ゲート・verdict スキーマ）
5. `CLAUDE.md`（環境制約・原則）
6. 直近の `docs/harness/log/` があれば前回状態を把握

**着手前ゲート**: `milestones/<Mn>-*/`（plan.md ＋ acceptance.md）が存在しない場合、
実装エージェントを起動せず停止し、`/cockpit-plan <要件>` での起案を先に行うようユーザーへ促す
（acceptance が無いまま回すと requirements-reviewer がトレース対象を持てず空回りする）。
plan.md に「未決」の設計論点が残っている場合も停止してユーザーに諮る。

**承認の記録**: ユーザーによる本コマンドの起動が plan 承認のイベント。ゲート通過後、
plan.md の `status: draft` を `approved` に更新してから実装ループへ入る
（既に approved / FIX 再開なら更新不要）。

## ループ手順（合格まで、最大5反復）

### 1. 実装
`cockpit-implementer` を Agent で起動し `IMPLEMENT <Mn>`（初回）または
`FIX` ＋ 集約済み blocking issue リスト（2回目以降）を渡す。
implementer の完了報告（files / tests / notes）を受け取る。

### 2. 静的ゲート
implementer 報告の `tests:` が赤、または不明なら、Bash で
`npx tsc --noEmit` / `npx eslint .` / `npx vitest run` を実測して確認する。
（"up to date" 等の自己申告を鵜呑みにせず、数値は実測する。）
赤があれば implementer に即差し戻し、手順1へ。

### 3. 並列レビュー（4体を1メッセージで同時起動）
以下を **同時に** Agent 起動し、それぞれ対象マイルストーンを伝える:
- `cockpit-code-reviewer`
- `cockpit-architect`
- `cockpit-usability-reviewer`
- `cockpit-requirements-reviewer`

各 verdict の `=== VERDICT ===` ブロックから `status` と `blocking` を抽出する。

### 4. ゲート判定（rubric の合格条件）
- 4体すべて `status: PASS` かつ `score >= 85` → **マイルストーン合格**。手順6へ。
- いずれか FAIL → 全レビュアーの blocking を1つのリストに集約（重複は統合、
  severity 順に整列）→ 手順1（FIX モード）へ。反復カウンタ +1。

### 5. 反復上限
反復が5に達しても未合格なら**停止**。残存 blocking をユーザーへ提示し、
続行/方針変更を仰ぐ。勝手に基準を下げて合格扱いにしない。
（このときも未解消の non_blocking は手順6と同じ要領で followups.md へ書き出す。）

### 6. 記録・出荷処理（append-only）
`docs/harness/log/<Mn>-iter<N>.md` に各反復の verdict 要約・変更ファイル・
最終判定を追記。**合格時は出荷処理**を行う:
1. plan.md の `status: approved` → `shipped` に更新
2. **残課題の書き出し**: 最終反復の verdict から未解消の `non_blocking`（major/minor）を
   集約し（重複統合・severity 順）、`milestones/<Mn>-*/followups.md` に書き出す
   （0件ならファイルを作らない）。この場で修正ループは回さない。
   次回以降の `/cockpit-plan` が起案時に参照する
3. `docs/claude-multi-window-spec.md` を**現在の姿**に更新（未反映の設計があれば本文へ、
   実装と spec の齟齬があれば spec を実態に整合。§6 に年表は書かない）
4. サマリをユーザーへ報告して停止（残課題があれば件数と followups.md の場所を含める。
   次 M へ自動で進まない。ユーザーの指示を待つ）。

## 原則
- レビュアーの blocking を実装者判断で無視しない。合意できない指摘はユーザーへエスカレーション。
- スコープは対象マイルストーンに限定。先取り実装を促さない。
- 各エージェントへは「何を」だけでなく「どの受け入れ基準・spec 節を満たすべきか」を明示して渡す。
