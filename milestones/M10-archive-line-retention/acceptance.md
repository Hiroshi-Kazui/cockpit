# M10 受け入れ基準 — アーカイブ保存時の行選別

requirements-reviewer の逐条トレース基準であり、implementer の実装スコープ定義。
各項目は「どのファイル/関数が満たすか」を特定できなければ未達扱い。
共通ゲート: `tsc --noEmit`（node/web）/ `eslint` / `vitest run` / `playwright test` が green。
出典は `milestones/M10-archive-line-retention/plan.md`（R-1〜R-8、D-1〜D-5）。

## R-1: 行選別の適用

- [ ] スプールの `transcript.jsonl` へ書き込まれる行が選別済みである（`src/main/archive/archiver.ts` の
      `syncOnce` が生バイトの `fs.appendFileSync` ではなく、選別を通過した行のみを追記する）
- [ ] ソース JSONL（`state.sourcePath`）に対する書き込み系 API 呼び出しが存在しない
      （`fs.statSync` / `fs.openSync(..., 'r')` / `fs.readSync` のみ。既存の不変条件の維持）
- [ ] 破棄された行がスプールにも出力先にも現れない（archiver の unit テストで、入力に
      `hook_success` 行を含めた場合にアーカイブ内容に出現しないことを固定）

## R-2: 保持する行

- [ ] `src/shared/archiveRetention.ts`（新規・純関数）が以下を保持と判定する。各項目に対応する
      unit テストが存在する
  - [ ] `type: "user"` で content が `text` ブロックのみの行
  - [ ] `type: "user"` で content がプレーン文字列の行
  - [ ] `type: "user"` で content が `image` ＋ `text` の行（人間のキャプションを失わないため行ごと保持）
  - [ ] `type: "assistant"`（`text` / `thinking` / `tool_use` のいずれを含む場合も）
  - [ ] `type: "attachment"` かつ `attachment.type` が `hook_blocking_error` /
        `hook_additional_context` / `plan_file_reference` / `invoked_skills`
  - [ ] `type: "attachment"` かつ `attachment.type` が `queued_command`（実行中の割り込み人間発話が
        唯一記録される行。`origin` の値で分岐せず全量保持。`origin.kind:"human"` の行・
        `origin: null`（task-notification）の行・`origin.kind:"auto-continuation"` の行の
        いずれも保持されることを unit テストで固定）
  - [ ] `type: "system"` かつ `subtype` が `compact_boundary` / `away_summary` / `turn_duration` /
        `informational`
- [ ] `metadata.json` は選別対象外で従来どおり全体が書かれる（`metadataWriter.ts` に変更がない）

## R-3: 破棄する行

- [ ] `archiveRetention` が以下を破棄と判定する。各項目に対応する unit テストが存在する
  - [ ] `type: "user"` で content が `tool_result` のみの行
  - [ ] `type: "attachment"` かつ `attachment.type` が `hook_success` / `async_hook_response` /
        `task_reminder` / `skill_listing` / `agent_listing_delta` / `deferred_tools_delta` /
        `command_permissions` / `auto_mode` / `plan_mode` / `plan_mode_exit` / `hook_cancelled` /
        `hook_system_message` / `nested_memory` / `file` /
        `compact_file_reference` / `edited_text_file`
        （`queued_command` は**破棄しない** — R-2 参照）
  - [ ] `type: "system"` かつ `subtype` が `stop_hook_summary` / `local_command` / `scheduled_task_fire`
  - [ ] `type` が `mode` / `permission-mode` / `ai-title` / `last-prompt` / `pr-link` /
        `queue-operation` / `file-history-snapshot` / `file-history-delta`

## R-4: 逐語保持

- [ ] 保持された行はソースの行テキストと**バイト一致**する（再シリアライズしていない）。
      キー順を入れ替えた行・非 ASCII エスケープを含む行・未知フィールドを持つ行を入力にした
      unit テストで、出力がソース行と同一であることを固定

## R-5: 寛容性（denylist）

- [ ] 未知の `type` を持つ行が**保持**される（unit テスト）
- [ ] `type: "attachment"` で未知の `attachment.type` を持つ行が**保持**される（unit テスト）
- [ ] `type: "system"` で未知の `subtype` を持つ行が**保持**される（unit テスト）
- [ ] JSON として不正な行・`attachment` フィールドが欠落した行・content が想定外の形の行が
      **保持**される（情報を失わない側に倒す。unit テスト）
- [ ] 空行・空白のみの行は追記されない（選別導入に伴う**変更点**。JSONL として意味を持たないため。
      M10 以前は生バイト複製だったので空行も複製されていた）

## R-6: 再開の正しさ

- [ ] ソース側読み取りオフセットがアーカイブサイズから独立して永続化される
      （サイドカー `archive-state.json`、`{ sourceOffset, lastUuid }`）
- [ ] サイドカーの書き込みが temp+rename（部分書き込みされた JSON を読まない）
- [ ] 再開判定が `shared/` の純関数として切り出され、`{ sidecar, archiveAnchor }` から
      「サイドカーの `sourceOffset` を採用 / 錨 uuid をソース走査して復元 / 0 から / 安全に停止」を返す。
      錨は「アーカイブ末尾行の `uuid`」ではなく「**`uuid` を持つ最後の行**」であり、
      サイドカーの `lastUuid` も同じ意味論に揃っている。以下の分岐に unit テストがある
  - [ ] サイドカーあり・`lastUuid` が錨の `uuid` と一致 → `sourceOffset` を採用
  - [ ] サイドカーあり・`lastUuid` 不一致（追記後にサイドカー更新前でクラッシュ）→ 走査で復元
  - [ ] サイドカーなし（M10 より前に作られた既存アーカイブへの再アタッチ）→ 安全な経路に落ちる
        （**アーカイブサイズをオフセットに使う経路は設けない**。選別済みアーカイブでもサイドカーは
        失われうるため、逐語アーカイブと区別できない。走査に一本化する）
  - [ ] サイドカーが不正 JSON / フィールド欠落 → 走査または 0 に落ちる（例外を投げて握り潰さない）
- [ ] どの分岐が算出したオフセットでも、採用前に「行境界（0 または `\n` の直後）に着地しているか」を
      検証し、外れていれば watch せず `onError` で可視化する（`isSourceOffsetAtLineBoundary`。
      行中オフセットからの読み出しを構造的に禁止する）
- [ ] サイドカーに永続化される `sourceOffset` が**確定オフセット**であり、読み込み途中の部分行の
      バイトを含まない（揮発の読み取りカーソルと分離されている）。部分行を跨ぐ detach → 再 attach で
      行の欠落も断片混入も起きないことを archiver の unit テストで固定
- [ ] アプリ再起動を模した再アタッチで、行の**重複追記が発生しない**（archiver の unit テスト:
      同一ソースに対し attach → sync → detach → attach → sync でアーカイブが増えない）
- [ ] 追記後・サイドカー更新前のクラッシュを模したケースで、重複も取りこぼしも発生しない

## R-7: 不変条件

- [ ] アーカイブに対する書き込みが追記のみ（`appendFileSync`）で、truncate / 書き換え経路が存在しない
      （サイドカーは進捗の派生状態でありアーカイブ本体ではない）
- [ ] 選別・サイドカー I/O の失敗が `callbacks.onError` で伝播し、握り潰されない（silent failure 禁止）
- [ ] 選別ロジックが `shared/` の純関数で、fs / DB / Electron を参照しない
- [ ] ミラー（`src/main/archive/mirror/**`）に変更がない（D-1: ADR-0008 / ADR-0009 は無改訂）

## R-8: 既存データ

- [ ] 既存アーカイブの再選別・削除・圧縮を行うコード経路が存在しない
- [ ] 選別前に書かれた行を含むアーカイブへ再アタッチしても、既存部分が変更されない

## 既存機能の回帰

- [ ] トークン集計が従来どおり動く（`assistant` 行の `usage` は保持対象。`aggregateUsage` 経路のテスト green）
- [ ] 目的の自動検出が従来どおり動く（`readUserText` が要求する `origin.kind==='human'` の
      `user` 行は保持対象。`purposeDetection` 系テスト green）
- [ ] 過去セッション閲覧が従来どおり動く（`parseJsonlLineForDisplay` が扱う user/assistant の
      text 行は保持対象。`archiveReader` / `archiveBrowser` 系テスト green）
- [ ] mirror 系テスト（`archiver.test.ts` / `fsSink.test.ts` / `mirrorCoordinator.test.ts` /
      `spoolReader.test.ts`）が green

## 削減効果の確認

- [ ] 実測データと同じ行構成を模した fixture（`hook_success` / `async_hook_response` /
      `tool_result` 単独 / 毎ターン重複系を含む）に対し、選別後のバイト数が選別前の
      **10% 未満**になることを unit テストで固定する（実測見込み 3.8%）
