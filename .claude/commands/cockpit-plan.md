---
description: 新規マイルストーンを起案する。milestones/<Mn>-<slug>/ に plan.md と acceptance.md を作成（Mn は自動採番）。直後に /cockpit-build <Mn> で実装へ移れる。アプリ実装はしない
argument-hint: <要件の説明>
---

# /cockpit-plan — cockpit マイルストーン起案

あなた（メインスレッド）は**プランナー**。アプリコード（`src/**`）は書かない。
**変更の単位は `milestones/<Mn>-<slug>/` ディレクトリ1つ**。ここに plan.md（起案・設計判断）と
acceptance.md（受け入れ基準）を作成して**停止**する。実装ループは起動しない（`/cockpit-build` の責務）。

要件: **$ARGUMENTS**（全体が要件の説明。マイルストーン番号は入力しない）

## 文書アーキテクチャ（前提）

- `docs/claude-multi-window-spec.md` = **システムの現在の姿**（要件・設計の source of truth）。
  変更履歴・マイルストーン一覧は持たない
- `milestones/<Mn>-<slug>/` = **変更の単位**。plan.md（frontmatter `status: draft|approved|shipped`）
  ＋ acceptance.md。起案時に書くのは**ここだけ**
- `docs/adr/` = 技術決定（1決定1ファイル・不変）。TD-1〜7 は `docs/technical-decisions.md` に凍結
- 承認はフィールドで構造化: 起案時 `status: draft` → **ユーザーが `/cockpit-build <Mn>` を起動した
  事実が承認**（build が `approved` に更新）→ 品質ゲート合格で `shipped`（build が spec を現在形に更新）

## 手順

### 1. 現状把握・採番
1. `docs/claude-multi-window-spec.md`（現在の姿。今回の要件がどこに触れるか）
2. `milestones/` の既存エントリ（書式・粒度の参考、進行中の M との競合確認）。
   `milestones/*/followups.md`（出荷済み M の残課題バックログ）があれば読み、
   今回の要件に関連する項目は plan.md への取り込みを検討する（取り込む/見送るは報告に明記し、
   判断が割れるものはユーザーに諮る）
3. `docs/adr/README.md`（既存決定との整合。次の ADR 番号）
4. `CLAUDE.md`（環境制約・規約）
5. 要件が触れる既存コード（`src/**`）を Grep / Read し、影響範囲・再利用点・守るべき不変条件を特定
   （網羅性を主張する前に、検証した範囲と未検証の範囲を区別する）
6. **採番**: `milestones/` の最大 M 番号を実測し +1（空なら凍結済み初期建設の最終 M5 の次 = M6 から）。
   欠番・重複を見つけたら握り潰さず報告に含める

### 2. 起案（書くのは milestones/<Mn>-<slug>/ のみ）
- **plan.md**: frontmatter（milestone / title / `status: draft` / created / decisions=ADR パス）＋
  背景（ユーザー発言の原文引用）・要件 R-x・設計判断の要旨・実装フェーズ
  （契約・純関数 unit test → main → renderer → E2E の順を基本）・リスク・スコープ外
- **acceptance.md**: requirements-reviewer が逐条トレースできる粒度のチェックリスト。
  各項目は「どのファイル/関数が満たすか」を特定可能であること（不能なら要件が曖昧）
- **設計判断が新規の技術決定を含む場合**: `docs/adr/<次番号>-<slug>.md` を作成し
  plan.md の `decisions:` から参照する（決定の本文は ADR、プランは要旨のみ。二重管理しない)
- CLAUDE.md の原則を崩さない前提で設計する: プロセス境界、IPC 型付き契約、パーサ寛容性、
  append-only 不変条件、副作用の集約、silent failure 禁止
- **真に方針が割れる論点**（後戻り困難・スコープを左右する選択）は確定させず、
  plan.md に「未決」と明記して停止しユーザーに諮る

### 3. 停止・報告
- **採番した `Mn` を冒頭に明示する**（例: 「採番: **M7**」）。ユーザーはこの番号でビルドを起動する
- 作成したファイル・設計判断の要旨・未決の論点（あれば）を報告する
- 締めは「異論がなければ `/cockpit-build <Mn>` で実装へ（起動が承認になる）。修正があれば指摘を」で**停止**
- `/cockpit-build` を自動起動しない

## やらないこと
- アプリコード（`src/**`）の実装・変更
- spec の書き換え（spec は**出荷時**に現在形へ更新する。`/cockpit-build` 合格処理の責務）
- `docs/technical-decisions.md`（凍結）・`docs/harness/acceptance-criteria.md`（凍結）への追記
- `/cockpit-build` の起動、次アクションの勝手な実行
- 方針が割れる論点をユーザーに諮らず確定すること
