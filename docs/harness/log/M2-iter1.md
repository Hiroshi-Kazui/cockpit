# M2 — 反復1 記録

- 日付: 2026-07-19
- 実装: cockpit-implementer（初回 IMPLEMENT M2）
- 静的ゲート（オーケストレータ実測）: tsc.node=0 / tsc.web=0 / eslint=0 / vitest 60/60 pass — green

## 主な新規/変更ファイル
shared/{statusline.ts,jsonl.ts}(+test), ipc.ts,
main/telemetry/{ports.ts,sessionCoordinator.ts,pipeServer.ts,settingsWriter.ts,telemetryLaunch.ts,forwarderPath.ts}(+test),
main/archive/{archiver.ts,metadataWriter.ts}(+test),
main/db/{schema.ts,sessionRepo.ts,purposeRepo.ts,db.ts}(+test),
main/{index.ts,ipc/handlers.ts,pty/ptyManager.ts}, preload/index.ts,
renderer/src/hooks/useSessionTelemetry.ts, renderer/src/components/Pane.tsx, styles.css,
resources/statusline-forwarder.js, package.json（chokidar@3.6.0）

## verdict 要約
| reviewer | status | score | blocking |
|---|---|---|---|
| code | FAIL | 74 | 1 |
| architect | PASS | 92 | 0 |
| usability | PASS | 88 | 0 |
| requirements | PASS | 92 | 0 |

## 集約 blocking（→ 反復2 へ差し戻し）
1. [blocking][security/不変条件] パイプ由来の session_id / transcript_path を無検証で FS パス構築（archiveDirFor, sessionCoordinator, metadataWriter, archiver）に使用 → `..` を含む値でアーカイブ外へ任意書込（append-only 違反＋パストラバーサル）。境界で session_id をホワイトリスト検証（`/^[A-Za-z0-9._-]+$/`・`..`拒否）し不正破棄、archive ルート配下の containment 検証、transcript_path も想定配下か確認。

## 併せて修正指示した major（堅牢性・記録完全性）
- [major] pipeServer.ts — 受信バッファ無制限で OOM。1行最大長を設け超過破棄。
- [major] index.ts/metadataWriter.ts — statusLine 発火毎に同期 writeFileSync＋IPC でメインスレッドを塞ぐ。デバウンス/非同期化。
- [major] index.ts — アーカイブ同期失敗（archiver onError）が console 止まりで UI 非可視。記録完全性が核の本アプリでは要可視化。ペイン内に控えめな警告インジケータ。

## 非 blocking（今回は任意対応）
- forwarder の write/chain タイムアウト、.pane-telemetry のコントラスト統一（#b8b8b8）、origin='resume' 未使用のコメント化、修復時 metadata 再書込。

## 最終判定
反復1: **FAIL**（code blocking 1件）。反復2（FIX）へ。
