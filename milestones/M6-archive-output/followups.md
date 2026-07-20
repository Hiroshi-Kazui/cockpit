# M6 残課題（followups）

> **✅ 全14件 M7 で解消済み（2026-07-21）**。`milestones/M7-mirror-hardening/` として起案・出荷。
> requirements-reviewer が M6 followups 14件と M7 acceptance の一対一解消を確認済み。
> 本ファイルは履歴として残す（新規の残課題は `milestones/M7-mirror-hardening/followups.md`）。

ビルドループ終了時（2026-07-21、合格）に残った non_blocking。次回 `/cockpit-plan` が起案時に参照する。
すべて blocking ではない（合格を妨げない）。severity 順。

## major

- **[major] `rebaselineSession` が `this.sink` を await 跨ぎで live 参照** — `src/main/archive/mirror/mirrorCoordinator.ts:209,228`。
  `runOnce`/`syncTranscript` は `const sink = this.sink` を冒頭で捕捉するが、`rebaselineSession` は
  `this.sink` を await 後に live 参照し `this.sink!` を非 null 断定する。root 高速切替時、旧 root A の
  in-flight rebaseline が `setOutputRoot('B')` 後に再開して B の sink 内容を読み、A の行を upsert し得る。
  データ破壊経路は無く単一行スキーマの再評価で自己修復するが、非同期の綻び＋型安全の嘘（`this.sink!` が実行時 null 可）。
  修正案: メソッド冒頭で `const sink = this.sink`（null ガード付き）を捕捉しクラス全体と一貫させる。

## minor（堅牢性・効率）

- **[minor] transient I/O 失敗が恒久 sentinel に昇格** — `mirrorCoordinator.ts:258`。切替時の宛先一時読み取り失敗
  （クラウド一時オフライン等）が `UNRECOVERABLE_SYNCED_BYTES` に昇格し、sentinel の transient-vs-permanent 方針（D-2）に反する。
  fail-safe（無書き込み・state=error 可視・root トグルで復帰可）だが、同一 root 滞在中の一時 blip は自動復帰しない。
  修正案: 一時的な stat/read 失敗（リトライ）と確定的な prefix 不一致（sentinel）を区別する。
- **[minor] 診断 last_error がリトライで上書き** — `mirrorCoordinator.ts:405`。sentinel エラー後の初回リトライで
  `computeTranscriptMirrorDiff` の汎用メッセージ（"exceeds spool size"）が具体診断（"does not match a genuine prefix"）を
  約2秒後に上書きし、原因説明が失われる。修正案: sentinel 行はリトライ再スケジュールを抑止、または元メッセージ保持。
- **[minor] UNRECOVERABLE 到達セッションが 60s バックオフで永続リトライ** — `mirrorCoordinator.ts:416`。恒久 error 状態でも
  タイマーが回り続ける（毎回即 return・破壊なし）。修正案: 恒久 error ではリトライ再武装を抑止。
- **[minor] sentinel の in-band 格納にコメント不足** — `mirrorCoordinator.ts:344` 付近の消費側（backfill 比較）に
  `UNRECOVERABLE_SYNCED_BYTES` への参照コメントが無い。突合ツール・将来リーダが額面解釈しないよう定数参照/リポジトリ層文書化を。
- **[minor] `readTranscriptPrefix` が `bytesRead` 未検証** — `fsSink.ts:84` / `spoolReader.ts`。現行呼び出し（length≤ファイルサイズ）では安全だが
  暗黙前提。`fsSink.test.ts` は length=4/0 のみ。修正案: bytesRead 検証か中間長/短読みのテスト追加。将来 DriveApiSink で部分読み検証が要る。

## minor（UX・i18n — usability 由来）

- **[minor] エラー文言の言語不整合** — `fsSink.ts:94`（プローブ失敗が生 errno 文字列）、`shared/mirrorPlan.ts:61`
  （append-only 違反 reason が英語）。日本語 UI に英語が露出。「出力先に書き込めません: …」等で日本語統一。
- **[minor] 「解除」に D-4 の説明が無い** — `ArchiveOutputSettings.tsx:175`。旧ミラーデータが残る旨（削除ではない）を
  hint に一文添えると誤解を防げる。
- **[minor] フォーカス復帰先の不一致** — `App.tsx:177`。StatusBar インジケータ経由で開いても閉じるとヘッダボタンに戻り、
  押した要素に戻らない。opener を記録して復帰先を分岐。
- **[minor] バックフィル開始直後の即時フィードバック欠如** — `ArchiveOutputSettings.tsx:93`。初回進捗イベントまで表示が空、
  長時間処理の予告・キャンセル手段なし。「開始しました…」の即時表示を。
- **[minor] エラーバッジのコントラストが境界域** — `styles.css:971`。濃色文字×赤背景10px。色単独依存ではない（文言冗長化済み）が調整余地。

## minor（効率・構造 — architect 由来）

- **[minor] `useMirrorStatus` の二重購読** — `App.tsx:67` と `ArchiveOutputSettings.tsx:40` で独立に初期フェッチ＋push 購読が2系統。
  App 保持の mirrorStatus を dialog に prop で渡し1系統に統合可能（挙動上の害なし）。
- **[minor] バックフィル時の status push が概算 O(N²)** — `mirrorCoordinator.ts`。`markSynced`/`recordError` 毎に
  `getStatusSummary`（root 内全行スキャン）を発火。backfill 経路では進捗イベントに集約する余地。
- **[minor] `startBackfill` が2責務で長い** — suffix 検出＋rebaseline/sync。判定ロジックを `shared/` の純関数（`computeBackfillPlan` 的）へ抽出するとテスト点が明快。

## 設計 followup（スコープ外だった論点）

- **[followup] 出力先の per-root 進捗の完全 resume** — 現状 `archive_mirror` は session_id 単一行（spec §5）。A→B→A で宛先 A が
  post-skip suffix になった場合、完全 resume はせず permanent-block（state='error'）で**安全に停止**する（無音破壊はしない）。
  完全な per-root resume には `(session_id, dest_root)` 複合キー化（spec §5 のデータモデル変更＋ADR 改訂）が必要。
  次に扱うなら: 複合キー化の是非、または「宛先手動クリア後の再開手段／バックフィル前提の運用手順」の UX 明示。
