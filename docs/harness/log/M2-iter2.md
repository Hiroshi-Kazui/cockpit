# M2 — 反復2 記録（FIX → 合格）

- 日付: 2026-07-19
- 実装: cockpit-implementer（FIX モード、反復1の blocking＋major 対応）
- 静的ゲート（オーケストレータ実測）: tsc.node=0 / tsc.web=0 / eslint=0 / vitest 98/98 pass（+38テスト）— green

## 変更ファイル（FIX 差分）
- src/shared/statusline.ts — isValidSessionId / isTranscriptPathAllowed 追加（+test）
- src/shared/paths.ts（新規）— resolveContainedPath（containment 検証、+test）
- src/shared/ipc.ts — cockpit:session:archiveError channel ＋ SessionArchiveErrorEvent 型
- src/main/telemetry/sessionCoordinator.ts — session_id 検証境界 / archiveDirFor null 処理 / transcript_path ゲート / onArchiverError（+test）
- src/main/telemetry/pipeServer.ts — PipeLineBuffer（1MB 上限、超過破棄＋復帰、+test）
- src/main/archive/metadataWriter.ts — createDebouncedMetadataWriter（500ms 集約・endedAt 即時・flushAll、+test）
- src/main/index.ts — archiveDirFor→string|null / debounced writer 配線 / before-quit flushAll / archiver onError→IPC
- src/preload/index.ts — session.onArchiveError bridge
- src/renderer/src/hooks/useArchiveWarning.ts（新規）, components/Pane.tsx（警告バナー）, styles.css（.pane-warning、.pane-telemetry コントラスト #b8b8b8）
- resources/statusline-forwarder.js — chain 5s タイムアウト

## verdict 要約
| reviewer | status | score | blocking |
|---|---|---|---|
| code | PASS | 92 | 0 |
| architect | PASS | 93 | 0 |
| usability | PASS | 91 | 0 |
| requirements | PASS | 93 | 0 |

## 反復1 blocking の解消確認
- [解消] パイプ由来 session_id / transcript_path のパストラバーサル → 三層防御（ホワイトリスト境界検証・resolveContainedPath containment・isTranscriptPathAllowed）。Windows 固有ケース（ドライブレター/UNC/`..`/root）網羅テスト、バイパス経路なし、正当な `~/.claude` 配下 transcript は誤弾きなし。

## 残存 non-blocking（M2 では許容、後続で検討）
- **CLAUDE_CONFIG_DIR 非対応**（requirements+usability が指摘）: claudeHomeDir が `~/.claude` 固定。config を移動したユーザーは全 transcript が不許可となりアーカイブ失敗（ただし warning で可視、silent ではない）。将来 `CLAUDE_CONFIG_DIR`／app_settings で transcript ルートを解決すべき。
- archive 警告の dismiss/回復手段なし・/clear 後の持ち越し（usability minor）
- pane=null の archiveError は UI 非表示で実質 console-only（architect+usability minor）
- onArchiveError（emit）と onArchiverError（handler）の命名が紛らわしい（architect minor）
- isTranscriptPathAllowed は lexical containment のみ（realpath なし、code minor）
- pipe overflow 時に直前の正当な部分行も巻き添え破棄（code minor）

## 最終判定
**M2 合格**（4レビュアー全員 PASS・score≥85・静的ゲート green）。反復数: 2。
次マイルストーン（M3）へは自動で進まず、ユーザー指示を待つ。
なお M3 着手前に spec §4.5 等の「累計トークン棒グラフ」→「コンテキスト消費量ゲージ（緑→オレンジ→赤）」の文書訂正が必要（既知の仕様訂正）。
