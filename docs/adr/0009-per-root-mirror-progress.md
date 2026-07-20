# ADR-0009: ミラー進捗の per-root 化（archive_mirror 複合キー）

- 日付: 2026-07-21
- 状態: accepted（M7 出荷済み、2026-07-21）
- 関連: ADR-0008（アーカイブミラー方式。本 ADR はその D-6 データモデルを**部分的に supersede**）、
  spec §4.4.1 / §5、milestones/M7-mirror-hardening/（起案元）、milestones/M6-archive-output/followups.md
- 先行の制約: M6 は `archive_mirror` を session_id 単一行で出荷した（spec §5）。このため出力先を
  A→B→A と往復すると root A の進捗記録が失われ、宛先 A が「スプールの真の prefix」でない場合は
  安全側の恒久エラー（permanent-block）で停止するに留まる（M6 反復3 の確定挙動。無音破壊はしない）

## 文脈

単一行スキーマでは「どの出力先へ何バイトミラー済みか」を出力先ごとに記憶できない。
root 切替のたびに進捗が上書きされ、復帰時は宛先内容の content 照合（ADR-0008 の防御）に
頼るしかなく、照合不能ケースは resume 不可になる。残課題の根本解決には進捗の per-root 化が必要。

## 決定

1. **`archive_mirror` の主キーを `(session_id, dest_root)` 複合キーに変更する**。
   各出力先が独立に進捗行を持ち、root 切替・復帰で互いを上書きしない。
2. **マイグレーションは起動時 idempotent** に行う（TD-6 の方針を踏襲）:
   旧形式（session_id 単一 PK）を検出したら新テーブルへ `INSERT SELECT` で移行 → rename。
   旧行は `(session_id, dest_root)` にそのまま写せるため情報の損失はない。
3. **content-prefix 照合（ADR-0008 / M6 反復3 の防御）は維持する**。per-root 行があっても、
   宛先が外部で改変されている可能性は残るため、復帰時は「記録進捗と宛先実サイズの一致検証＋
   先頭バイト照合」を通ってから resume する。照合不一致は従来どおり恒久エラー。
4. **恒久エラー（sentinel）と一時エラーを区別する**: 宛先の stat/read が一時的に失敗した場合は
   リトライ（D-2 の結果整合）に分類し、sentinel へ昇格させない。sentinel は「照合不一致＝
   宛先がスプール由来でない」という確定的な状態にのみ用いる。
5. spec §5 の `archive_mirror` 定義は M7 出荷時に本 ADR の形へ更新する（出荷時 spec 整合の規約どおり）。

## 帰結

- A→B→A の往復で各 root の続きから自動 resume できる（M6 の permanent-block ケースは
  「宛先が外部改変された場合」のみに縮小）
- `UNRECOVERABLE_SYNCED_BYTES` sentinel の役割が明確化（履歴喪失の代償ではなく、真の不整合の印）
- `dest_root` ごとの行が増えるため、状態 UI・backfill は「現在の出力先の行」を対象に絞る
- ADR-0008 の D-1〜D-5 は不変。D-6 のうち「単一行・復旧可能な派生状態」の後者のみ維持され、
  単一行の前提が本 ADR で置き換わる
