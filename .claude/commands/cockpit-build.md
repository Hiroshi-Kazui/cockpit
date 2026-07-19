---
description: cockpit をマイルストーン単位で「Sonnet実装→Opus4レビュー→fix」ループで品質ゲート合格まで自動構築する
argument-hint: <M1|M2|M3|M4|M5>
---

# /cockpit-build — cockpit 開発オーケストレータ

あなた（メインスレッド）は**指揮者**。自分でアプリコードは書かず、実装は
`cockpit-implementer`（sonnet）、レビューは4体の opus レビュアーに委ね、
品質ゲート合格までループを回す。

対象マイルストーン: **$ARGUMENTS**（未指定なら M1）

## 前提の読み込み（最初に必ず）
1. `docs/claude-multi-window-spec.md`（該当マイルストーン節）
2. `docs/technical-decisions.md`（TD-1〜TD-6。spec の空白を埋める確定判断）
3. `docs/harness/acceptance-criteria.md`（該当 M のチェックリスト）
4. `docs/harness/review-rubric.md`（合格ゲート・verdict スキーマ）
5. `CLAUDE.md`（環境制約・原則）
6. 直近の `docs/harness/log/` があれば前回状態を把握

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

### 6. 記録（append-only）
`docs/harness/log/<Mn>-iter<N>.md` に各反復の verdict 要約・変更ファイル・
最終判定を追記。合格時はサマリをユーザーへ報告し、次マイルストーンの提案で止まる
（次 M へ自動で進まない。ユーザーの指示を待つ）。

## 原則
- レビュアーの blocking を実装者判断で無視しない。合意できない指摘はユーザーへエスカレーション。
- スコープは対象マイルストーンに限定。先取り実装を促さない。
- 各エージェントへは「何を」だけでなく「どの受け入れ基準・spec 節を満たすべきか」を明示して渡す。
