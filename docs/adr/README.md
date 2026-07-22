# ADR 索引 — cockpit 技術決定記録

1決定1ファイル・不変（変更は新 ADR で supersede）。新規決定は次番号で追加する。

| ADR | タイトル | 状態 | 場所 |
|---|---|---|---|
| 0001 | 起動完了検知 | accepted | `../technical-decisions.md` TD-1（凍結） |
| 0002 | ペイン内セッション切替と目的引き継ぎ | accepted | 同 TD-2 |
| 0003 | ended_at の確定 | accepted | 同 TD-3 |
| 0004 | statusLine フォワーダとチェーン | accepted | 同 TD-4 |
| 0005 | Windows での claude CLI spawn | accepted | 同 TD-5 |
| 0006 | ビルドツール・保存場所・IPC 命名ほか | accepted | 同 TD-6 |
| 0007 | 目的ライフサイクルと再起動復帰 | accepted | 同 TD-7 |
| 0008 | アーカイブ出力先の設定・ミラー方式 | accepted | [0008-archive-mirror.md](0008-archive-mirror.md) |
| 0009 | ミラー進捗の per-root 化（複合キー） | accepted | [0009-per-root-mirror-progress.md](0009-per-root-mirror-progress.md) |
| 0010 | 目的完了時の評価パイプライン | proposed | [0010-purpose-evaluation-pipeline.md](0010-purpose-evaluation-pipeline.md) |

TD-1〜TD-7（2026-07-19 決定）は `docs/technical-decisions.md` に凍結のまま残す
（コード・過去ログからの `TD-n` 参照を壊さないため）。ADR-0008 以降はこのディレクトリに追加する。
