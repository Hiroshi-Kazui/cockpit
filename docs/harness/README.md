# cockpit 開発ハーネス

Sonnet 実装 → Opus 4レビュアー → fix 差し戻し を、品質ゲート合格まで自動反復する
オーケストレーション。実装環境（Electron/TS/React/xterm/node-pty/better-sqlite3, Windows）に
最適化してある。

## 構成

```
/cockpit-build <M1..M5>     ← オーケストレータ（メインスレッドが指揮）
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

## 反復ログ

各反復の verdict と差分要約は `docs/harness/log/<milestone>-iter<N>.md` に追記（append-only）。
これ自体が「開発を一任する疑似AGIハーネスの構築素材」になる。

## 使い方

```
/cockpit-build M1        # M1 を合格まで回す
```

初回は npm 環境未初期化のため、implementer が M1 でプロジェクト scaffold
（Electron+TS+Vite、native module の electron-rebuild 設定含む）から行う。
