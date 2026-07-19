# M4 拡張 — 「目的が空なら初回発言から決定」（課題ゼロ収束）

- 日付: 2026-07-19〜20
- 契機: ユーザー要望「目的が空なら、ユーザが最初に送ったプロンプトから決定する」。設計判断: (1) スラッシュコマンド/スキル以外の発言を目的とみなす (2) 決定前は「未設定」表示。範囲: 基本機能のみ（書き換えスキル連携はスコープ外）。
- 事前に spec §4.2/§4.6・acceptance-criteria M4 を更新（source of truth の upstream 訂正）。
- 静的ゲート（最終・オーケストレータ実測）: tsc.node=0 / tsc.web=0 / eslint=0 / vitest 309/309 pass — green

## 実装の骨子
- 目的入力ダイアログは空でも開始可（任意入力）。空時は初回プロンプトを自動送信しない。
- JSONL 監視の第3消費者 `PurposeDetectionCoordinator` を追加（M3 UsageCoordinator と同パターン、SessionCoordinator の TD-2/3 は不変）。
- 検出純関数 `shared/purposeDetection.ts::findFirstPurposeCandidate`＋`shared/jsonl.ts::readUserText`。**実 transcript 調査で「カスタムスキル/コマンドは展開後 markdown 本文として記録され `/` 始まりにならず origin 無し」と判明**したため、`origin.kind==='human'` 厳密判定でスキル本文の誤採用（false positive）を防止。
- 決定時に purpose.text/title を update、sessions への backfill、`resyncSessionsForPurpose` で metadata.json をデバウンス経路で決定論的に収束。決定前ヘッダは「未設定」＋「最初の発言がこの目的になります」ヒント。

## 反復と収束
- 反復1: 実装（ゲート充足だが major）。code 93/architect 92/usability 88/requirements 92。
- 反復2: major 解消（metadata eventual-consistency の resync／空目的の行動喚起ヒント）＋minor（再開文言・コントラスト・backfill 限定・origin ドリフト診断・sdk ガード）。usability 93/architect 95/code 96/requirements 96。残 minor: origin ドリフト診断が shared/jsonl.ts の純粋性を軽微に逸脱（code＋architect が同箇所指摘）。
- 反復3: 純粋化リファクタ — 診断副作用を shared/jsonl.ts から除去し純データ `isUserTurnMissingHumanOrigin` へ、カウンタ＋注入 logger を purposeDetectionCoordinator（impure 層）へ移動。検出挙動 byte-for-byte 不変。

## 最終 verdict（反復3・全員 指摘ゼロ）
| reviewer | status | score |
|---|---|---|
| code | PASS | 98 |
| architect | PASS | 98 |
| requirements | PASS | 96 |
（usability は反復2で PASS 93・指摘ゼロ。反復3は parser 純粋化で UI 非関与のため省略）

## 既知のインフラ制約（closable でない・正直に開示済み）
- sessionRepo の backfill WHERE 句の実 SQL テストは better-sqlite3 が Electron ABI で vitest から読めないため不可（プロジェクト全体の既知制約。fake store で代替）。
- Pane.tsx の render テストは repo に renderer テスト基盤（jsdom/RTL）が無いため不可（tsc:web の型検証で担保）。
- いずれも本機能が新規に作った欠陥ではなく、M5 で E2E/renderer テスト基盤を入れる際に拾える。

## 最終判定
**空目的機能は課題ゼロに収束**（最終3体 PASS・指摘ゼロ・静的ゲート green、vitest 309/309）。spec §4.2/§4.6 更新済み。書き換えスキル連携は未実装（スコープ外・将来追加可能）。
