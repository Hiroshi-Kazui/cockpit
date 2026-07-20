# ADR-0008: アーカイブ出力先の設定・ミラー方式

- 日付: 2026-07-20
- 状態: accepted
- 関連: spec §4.4.1 / §5 / §7、milestones/M6-archive-output/（起案元プラン）
- 先行: ADR-0001〜0007 は `docs/technical-decisions.md`（凍結）の TD-1〜TD-7 として記録

## 文脈

アーカイブ先は `app.getPath('userData')/archive/<session_id>/` 固定だった（TD-6）。
ユーザー要望「コンテキストの出力先を自由に設定できるようにしたい。GoogleDrive などの
インターネット上のストレージにも」を受け、出力先の設定可能化とクラウド対応の方式を決める。
制約: append-only・元 JSONL 非改変・ハーネス素材としての完全性（spec §4.4）、
claude の対話 UX を損なわない（spec §4.1）。

## 決定

- **D-1**: 設定可能なのはアーカイブ出力（`transcript.jsonl`＋`metadata.json`）のみ。
  SQLite DB（`cockpit.db`）は破損・ロック競合回避のため `userData` 固定でミラー対象外
  （SQLite over sync storage は既知のアンチパターン）。
- **D-2**: 方式は「ローカルスプール主 + 非同期ミラー」。一次保存は従来どおり `userData/archive` で
  完全性を担保し、そこから設定出力先へ**追記差分を非同期同期**（結果整合）。クラウド同期フォルダへの
  直接 append はオフライン・高レイテンシ・ロックで完全性と対話 UX を同時に守れないため採らない。
- **D-3**: クラウド対応は**同期クライアント経由**（Google Drive for Desktop / OneDrive / Dropbox の
  同期フォルダ・マウントドライブを出力先に指定）を Tier 1 サポート。Drive API 直結（OAuth）は
  Tier 2 でスコープ外。書き込み先を `ArchiveSink` インターフェースに抽象化し将来
  `DriveApiSink` 等を追加可能に。
- **D-4**: 出力先変更時、過去のミラー済みデータは移動・削除しない（append-only をミラー先にも適用）。
  過去分の一括ミラーは**明示操作のバックフィル**で提供（自動実行しない）。
- **D-5**: 出力先はプローブ（一時ファイル作成→削除）で検証。スプール自身・配下は指定不可
  （`shared/paths.ts` の containment 流用）。ミラー同期状態（synced / pending / error＋last_error）を
  UI 表示、silent failure 禁止。
- **D-6**: データモデルは `app_settings.archive_output_root` ＋ `archive_mirror` テーブル（spec §5）。
  ミラー先ディレクトリ構造はスプールと同一（`<output_root>/<session_id>/transcript.jsonl` ＋
  `metadata.json`）。`archive_mirror` はスプールを正とする**復旧可能な派生状態**。

## 帰結

- 出力先が不調でも記録は途切れない（スプールが正）。クラウド反映は結果整合で、
  タイミングは同期クライアント依存（spec §7 にリスクとして記載）
- TD-6 の「アーカイブ先固定」は「一次保存（スプール）の位置」という意味に再解釈される
- 将来 API 直結を足す場合も `ArchiveSink` 実装の追加で済み、Coordinator・DB は不変
