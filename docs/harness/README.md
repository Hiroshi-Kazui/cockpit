# cockpit 開発ハーネス

Sonnet 実装 → Opus 4レビュアー → fix 差し戻し を、品質ゲート合格まで自動反復する
オーケストレーション。実装環境（Electron/TS/React/xterm/node-pty/better-sqlite3, Windows）に
最適化してある。

## 構成

```
/cockpit-plan <要件>        ← 起案（milestones/<Mn>-<slug>/ を自動採番で作成、実装はしない）
/cockpit-build <Mn>         ← オーケストレータ（メインスレッドが指揮。起動 = plan 承認）
   │
   ├─ cockpit-implementer   (sonnet)  実装・fix
   │
   └─ 並列レビュー (opus 4体)
        ├─ cockpit-code-reviewer         正確性・型・セキュリティ
        ├─ cockpit-architect             アーキテクチャの美しさ
        ├─ cockpit-usability-reviewer    UX
        └─ cockpit-requirements-reviewer 要件充足
```

品質基準: `docs/harness/review-rubric.md`

## ループ

1. オーケストレータが対象マイルストーンの受け入れ基準を implementer に渡し実装させる
2. `tsc --noEmit` / `eslint` / テストを実行（赤なら implementer に即修正）
3. 4レビュアーを **並列** 起動し、それぞれ verdict を返させる
4. 全員 PASS かつ score>=85 → マイルストーン合格、記録して次へ
5. FAIL → blocking issue を集約し implementer に fix 依頼 → 手順2へ（最大5反復）
6. 5反復で未合格 → 停止しユーザーへ残存 blocking を報告
7. ループ終了時（合格・打ち切りとも）、未解消の non_blocking（major/minor）は
   `milestones/<Mn>-<slug>/followups.md` へ集約（0件なら作らない）。
   次回の `/cockpit-plan` が起案時に参照し、取り込みを判断する

## 反復ログ

各反復の verdict と差分要約は `docs/harness/log/<milestone>-iter<N>.md` に追記（append-only）。
これ自体が「開発を一任する疑似AGIハーネスの構築素材」になる。

## 使い方

```
/cockpit-plan <要件の説明>   # 起案。milestones/<Mn>-<slug>/ に plan.md + acceptance.md（Mn 自動採番）
/cockpit-build M6            # 該当 M を合格まで回す（起動が plan 承認。合格で status: shipped + spec 現在形反映）
```

受け入れ基準の場所: M6 以降は `milestones/<Mn>-<slug>/acceptance.md`。
初期建設 M1〜M5 は `acceptance-criteria.md`（凍結。回帰の正はテストスイート）。
技術決定: ADR-0008 以降は `docs/adr/`、TD-1〜7 は `docs/technical-decisions.md`（凍結）。
