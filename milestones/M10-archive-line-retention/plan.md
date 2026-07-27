---
milestone: M10
title: アーカイブ保存時の行選別（解析用途に必要な行だけをストックする）
status: shipped   # draft → approved（/cockpit-build 起動 = 承認イベント）→ shipped（品質ゲート合格）
created: 2026-07-27
decisions: docs/adr/0011-archive-line-retention.md
---

# M10 — アーカイブ保存時の行選別（解析用途に必要な行だけをストックする）

## 1. 背景・要望

> これらは整理可能で今後のエージェントとのやり取りの改善に生かせそうなボリュームになっているか？

> では、今後はより解析しやすいボリュームになるように修正せよ。

> 既存のコンテキストを修正する必要はない。今後コンテキストの保存方法を修正するだけだ

> 増やさなくていい。ストックする情報の削減
> 後で解析するための必要と思える情報だけがストックされるように

（2026-07-27 セッションでのユーザー発言。出力先 `H:\マイドライブ\dev\context` の観測結果を受けた要件）

起案者は当初「逐語ファイルを残したまま解析用の派生ファイルを併置する」案を提示したが、
ユーザーは**ファイルを増やす方向を明確に却下**し、保存する情報そのものの削減を指示した。
本マイルストーンはその指示に従う。既存の保存済みデータは対象外（変更しない）。

### 実測（出力先 `H:\マイドライブ\dev\context`、31 セッション / 287MB / 67,235 行）

解析に使える情報は全体の約 0.05%（人間発話 616 件・136KB）しかなく、残りは機械的ノイズだった。

| 行種 | 容量 | 内訳・備考 |
|---|---|---|
| `attachment` | 209MB | うち `hook_success` ＋ `async_hook_response` で **203MB**。ECC の Pre/PostToolUse フックが毎ツール呼び出しごとに claude 自身の JSONL へ書く正常時 payload（hook 別: PostToolUse:Edit 61MB / PostToolUse:Bash 32MB / take_screenshot 22MB / PreToolUse:Bash 20MB）。stderr は全体で 0.7MB のみ＝失敗ログではなく正常時の量 |
| `user` | 36MB | ブロック別: `tool_result` 12.4MB / `image` 4.8MB / `text` 0.66MB ＋ 行 envelope |
| `assistant` | 20MB | ブロック別: `thinking` 6.9MB / `tool_use` 2.5MB / `text` 0.67MB ＋ 行 envelope |
| `system` | 8.2MB | `stop_hook_summary` 7.86MB / `turn_duration` 0.27MB / `away_summary` 0.04MB / `compact_boundary` 0.01MB / 他は各 0.01MB 未満 |
| 毎ターン重複系 | 3.2MB | `file-history-snapshot` 1.4MB / `last-prompt` 0.6MB / `mode` 0.3MB / `permission-mode` 0.3MB / `ai-title` 0.3MB / `pr-link` 0.3MB / `queue-operation` 0.3MB / `file-history-delta` 0.1MB |

行単位選別が成立することを裏付ける実測（設計の前提）:

- **`tool_result` は必ず単独行** — 3,691 行 / 30.5MB（行バイト）。`text` ブロックとの混在は **0 件**。
  行ごと破棄しても人間の発話を 1 件も失わない
- **`image` は人間のキャプションと同一行** — `image,text` 36 行 / 4.88MB。行ごと破棄すると人間発話 36 件を失う
  → 行ごと保持する（画像ブロックのみの除去は再シリアライズが必要。D-2 参照）
- **保持対象の全行種が `uuid` を 100% 保有** — `user` 4,691 / `assistant` 8,125 / `attachment` 37,425 /
  `system` 1,273 の全行に `uuid` あり。`uuid` を持たない 15,721 行（`mode` / `permission-mode` /
  `ai-title` / `last-prompt` / `pr-link` / `file-history-*` / `queue-operation`）は全て破棄対象。
  再開の錨（D-4）が常に成立する

## 2. 要件

- **R-1（行選別の適用）**: スプールへ書き込む行を選別し、解析に必要な行だけを保存する。
  破棄した行はスプールにも出力先にも一切残らない。ソース JSONL（claude 管理下）は従来どおり
  読み取り専用で一切変更しない
- **R-2（保持する行）**: 以下は必ず保持する。
  - `user`（人間の発話。`text` ブロックのみの行、プレーン文字列 content の行、`image,text` の行）
  - `assistant`（`text` / `thinking` / `tool_use` を含む行。トークン集計の `usage` もこの行にある）
  - `attachment` のうち `hook_blocking_error` / `hook_additional_context` / `plan_file_reference` /
    `invoked_skills`（運用ルールが実際に効いたかを追える証跡）
  - `attachment` のうち `queued_command` — **エージェント実行中に人間が割り込んで打った発話は
    この行にしか存在しない**（H: 実測: 45 行中 26 行が `origin.kind:"human"`、うち `type:"user"` 行に
    同一本文があるのは 2 行のみ ＝ 約 24 件が唯一の記録）。しかも「ながい。３行が原則だ」
    「お前のくそ長い前置きのせいで前提が見えない」等、軌道修正の瞬間という解析価値が最も高い発話。
    `origin` の値で条件分岐はせず**全量保持**する（D-3 の「保持に倒す」に従う。45 行 ≒ 30KB で
    容量影響は無視できる）
  - `system` のうち `compact_boundary` / `away_summary` / `turn_duration` / `informational`
  - `metadata.json` は従来どおり全体を保持（選別対象外）
- **R-3（破棄する行）**: 以下は破棄する。
  - `user` のうち content が `tool_result` のみの行（Bash stdout・Read したファイル本文。コードから再現可能）
  - `attachment` のうち `hook_success` / `async_hook_response`（203MB の主因）、および
    `task_reminder` / `skill_listing` / `agent_listing_delta` / `deferred_tools_delta` /
    `command_permissions` / `auto_mode` / `plan_mode` / `plan_mode_exit` / `hook_cancelled` /
    `hook_system_message` / `nested_memory` / `file` / `compact_file_reference` /
    `edited_text_file`
    （**`queued_command` は破棄しない** — R-2 参照。当初の起案で破棄側に置いていたのは誤りで、
    usability レビューの指摘を受けて訂正した）
  - `system` のうち `stop_hook_summary` / `local_command` / `scheduled_task_fire`
  - `mode` / `permission-mode` / `ai-title` / `last-prompt` / `pr-link` / `queue-operation` /
    `file-history-snapshot` / `file-history-delta`
- **R-4（逐語保持）**: 保持する行は**元の行テキストをそのまま**書き出す。再シリアライズしない
  （キー順・エスケープ・未知フィールドを変えない）
- **R-5（寛容性）**: 判定は denylist。未知の `type` / `attachment.type` / `system.subtype` は
  「保持」に倒す（spec §7）。将来 claude CLI が追加する行種を取りこぼさない
- **R-6（再開の正しさ）**: アプリ再起動・`/resume`・クラッシュ後の再アタッチで、行の重複追記も
  取りこぼしも起こさない。選別によって「アーカイブのサイズ＝ソースの読み取りオフセット」という
  現行の等式が崩れるため、ソース側オフセットを別途永続化し、採用前に検証する
- **R-7（不変条件）**: append-only を維持する（追記のみ。削除・編集経路を作らない）。
  元 JSONL 非改変、pty 素通し非干渉、副作用の集約、silent failure 禁止をすべて維持する
- **R-8（既存データ）**: 既存の保存済みアーカイブ・ミラー済みデータは変更しない。移行処理を行わない。
  切替後の追記分から選別が効く（ユーザー明示指示）

期待効果: **同じ H: コーパスに出荷ポリシーを適用した実測で 303.0MB → 29.8MB（保持率 9.85%、約 90% 削減）**。
起案時に「約 11MB / 3.8%」と見積もったのは誤りで、保持行 1 行ごとの envelope バイト
（`uuid` / `parentUuid` / `cwd` / `gitBranch` / `version` / `timestamp` 等が毎行に付く）を
ブロック単位の集計から落としていた。残余の主因は assistant 行 21.4MB（thinking 6.9MB ＋ envelope）と
`image,text` 4.88MB。acceptance の「fixture で 10% 未満」は green だが実データの余裕は 0.15pt しかない。

## 3. 設計判断の要旨（本文は ADR-0011）

- **D-1（選別の位置）**: `src/main/archive/archiver.ts` のスプール書き込み時に選別する。
  ミラー（`archive/mirror/`）はスプールのバイト複製という現行の位置づけのまま変えないので、
  **ADR-0008 / ADR-0009（バイト前方一致による resume 検証）は無改訂で成立する**。
  スプールが選別済みになるだけ
- **D-2（粒度は行単位・逐語）**: 保持する行は元の行テキストをそのまま追記する。ブロック単位の
  切除（`image,text` 行から画像だけを落とす等）は再シリアライズを伴い R-4/R-5 と衝突するため
  行わない。実測で最大の無駄（`tool_result` 30.5MB）が単独行なので、行単位で目的を達する
- **D-3（denylist）**: 保持ではなく破棄を列挙する。未知行は保持。spec §7 の寛容パーサ原則と同じ倒し方
- **D-4（再開オフセット）**: サイドカー `archive-state.json`（`{ sourceOffset, lastUuid }`、temp+rename）を
  セッションのアーカイブディレクトリに置く。再アタッチ時はアーカイブ末尾行の `uuid` と `lastUuid` の
  一致を確認してから `sourceOffset` を採用し、不一致・欠損なら `lastUuid` をソース側で走査して復元する。
  サイドカーは `fsSink` のミラー対象外（`transcript.jsonl` と `metadata.json` のみ）なので出力先を汚さない
- **D-5（既存データ非移行）**: 既存アーカイブは触らない。1 ファイル内で「前半＝選別前・後半＝選別後」の
  混在を許容する

## 4. 実装フェーズ

1. **`shared/` の純関数（test-first）** — `src/shared/archiveRetention.ts`。
   1 行の生テキストを受け取り保持/破棄を返す。R-2/R-3/R-5 の全分岐と、実測で確認した
   行形状（`tool_result` 単独 / `image,text` / プレーン文字列 content / `uuid` 有無）を unit テストで固定。
   未知 type・不正 JSON・空行の扱いも固定（不正 JSON は保持側に倒す — 情報を失わない）
2. **`shared/` の再開判定（test-first）** — サイドカーの妥当性判定と復元オフセット算出を純関数化。
   `{ sidecar, archiveLastUuid }` から「採用 / uuid 走査で復元 / 0 から」を決定的に返す
3. **main（副作用層）** — `archiver.ts` の書き込みを選別済み行の追記に変更し、サイドカーの
   読み書き（temp+rename）とアタッチ時の検証を実装。`syncOnce` の `parseBuffer`（部分行の持ち越し）は
   ソースオフセット基準のまま維持
4. **回帰確認** — 既存の `archiver.test.ts` / `archiveReader.test.ts` / `archiveBrowser.test.ts` /
   mirror 系テストが green。トークン集計（`assistant.usage`）・目的自動検出（`readUserText`）・
   過去セッション閲覧（`parseJsonlLineForDisplay`）が選別後も従来どおり動くことを固定

renderer / IPC の変更はない（設定 UI を伴わない。R-2/R-3 の方針は固定ポリシーとしてコードに置く）。

## 5. リスク

- **M9（draft）との相互作用** — M9 の評価パイプラインはアーカイブを LLM 入力に使う（D-8 で
  ユーザー発言全量優先・アシスタント抜粋）。`tool_result` を落とすと「エージェントが何を見て
  判断したか」の材料が減る。M9 の入力構築はユーザー発言優先なので影響は小さいと見込むが、
  M10 と M9 の実装順によっては M9 側の入力設計に注記が必要
- **denylist の追従コスト** — claude CLI が新しいノイズ行種を追加した場合、denylist に載るまでは
  保持される（容量が再び膨らむ）。寛容性（取りこぼさない）とのトレードオフとして受容する。
  検知手段は設けない（過剰）
- **再開の窓** — 追記とサイドカー更新は原子的に束ねられない。追記後・サイドカー更新前のクラッシュでは
  `lastUuid` 不一致となり uuid 走査で復元する経路に落ちる。この経路をテストで固定しないと
  重複追記（append-only 汚染）を招く。実装フェーズ 2 の純関数化はこのため
- **混在ファイル** — D-5 により 1 ファイル内に選別前後が混在する。解析側が「前半にノイズがある」ことを
  知らないと集計を誤りうる。マーカーは付けない（append-only にメタ行を差し込まない）方針

## 6. スコープ外

- 既存の保存済みアーカイブ・ミラー済みデータの再選別・圧縮・削除（ユーザー明示指示）
- ブロック単位の切除（`image` ブロックのみの除去、`tool_result` の先頭 N 文字への切り詰め等）
- 選別ポリシーのユーザー設定 UI（固定ポリシーとして実装する）
- ミラー側（`archive/mirror/`）の設計変更、ADR-0008 / ADR-0009 の改訂
- 上流（ECC フック側）で JSONL への出力量を減らすこと（別リポジトリの設定。本アプリの関知外）

## 7. spec 更新（出荷時 = `/cockpit-build` 合格処理の責務）

- **§4.4** の「アーカイブは追記のみ（append-only）。削除・編集機能は設けない。**ハーネス素材としての
  完全性を優先する**」を改訂する。逐語の完全コピーではなく、解析用途に必要な行を選別して
  append-only に保存する方針へ。「元ファイルは一切変更しない」「削除・編集機能は設けない」は不変
- **§4.4** の「紐付けたJSONLを追記監視し、アプリ管理のアーカイブディレクトリへ同期コピーする」に
  行選別が入る旨を反映
- **§4.4** のアーカイブディレクトリ構成に、サイドカー **`archive-state.json`**（再開状態の派生・
  ミラー対象外）が併置される旨を追記（新しい永続物なので現在形の spec に必要）
- **§4.4.1「対象外」**（現在は SQLite インデックスのみ列挙）に、サイドカーがミラー対象外である旨を追記
- **§7** に denylist 追従のリスク（新しいノイズ行種は載るまで保持される）を追記
- **§7** に、`uuid` を持たない保持行が実在するため `scan` 経路での復帰時に当該行が 1 回だけ
  重複追記されうる旨を追記（ADR-0011 D-4 の訂正項に対応）
