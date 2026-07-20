# M6 反復1 ログ

日時: 2026-07-20
対象: M6 — アーカイブ出力先の設定可能化（クラウドストレージ対応）

## 実装（cockpit-implementer）
Phase 1〜4 実装。新規: `src/shared/mirrorPlan.ts`, `src/main/db/archiveMirrorRepo.ts`,
`src/main/archive/mirror/{sink,fsSink,spoolReader,mirrorCoordinator}.ts`,
`src/renderer/src/components/ArchiveOutputSettings.tsx`, `src/renderer/src/hooks/useMirrorStatus.ts`,
`e2e/archive-output.spec.ts`。変更: ipc.ts, schema.ts, appSettingsRepo.ts, index.ts, handlers.ts,
preload/index.ts, App.tsx, StatusBar.tsx, styles.css。

## 静的ゲート（オーケストレータ実測）
tsc（node/web）エラー0 / eslint エラー0 / vitest 399/399 pass。→ 通過

## レビュー verdict
| reviewer | status | score |
|---|---|---|
| architect | PASS | 93 |
| usability | FAIL | 79 |
| requirements | FAIL | 72 |
| code | FAIL | 58 |

## 集約 blocking（重複統合・severity 順）
1. **[blocking] 起動時リベースがクラッシュ復旧を破壊（silent data loss）** — `mirrorCoordinator.ts:127-161` + `index.ts:182-186`。
   起動時 `setOutputRoot(persistedRoot)` が `currentRoot=null` から呼ばれ D-4 リベースが全セッションに走り、
   永続 `synced_bytes` を `spoolSize/synced` で上書き → `recoverOnStartup` が noop 化し未同期テールが永久に届かない。
   AC#8 / spec §4.4.1 / ADR-0008 D-6 違反。requirements・code の両者が独立検出。
   復旧 unit テスト（`mirrorCoordinator.test.ts:353-366`）がこのバグを手動回避して通過している点も是正必須。
2. **[blocking] backfill が skip-rebaseline 済みセッションを転記破壊（silent）** — `mirrorCoordinator.ts:200-240,302-326`。
   宛先が post-config suffix を保持する場合、backfill が `spool[destSize:]` を既存 suffix の後ろに追記し
   重複・破損した transcript を `synced` で報告。AC#4/#9 違反。code 検出。
3. **[blocking] モーダル表示中のペインフォーカス奪取未停止** — `App.tsx:128`。
   `ArchiveOutputSettings`（aria-modal）表示中に Ctrl+1..4 の capture リスナが停止されず、
   背後のライブ claude pty へキー入力が漏れ得る。SessionBrowser で guard 済みの同型バグの付け忘れ。usability 検出。

## 判定: FAIL → 反復2（FIX）へ
non_blocking（i18n・二重購読・backfill last_error 等）はゲート終了時に followups.md へ。
