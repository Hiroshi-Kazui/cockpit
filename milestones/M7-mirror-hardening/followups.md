# M7 残課題（followups）

ビルドループ終了時（2026-07-21、合格）に残った non_blocking。次回 `/cockpit-plan` が起案時に参照する。
すべて blocking ではない（合格を妨げない）。すべて minor。

## minor（堅牢性・silent failure）

- **[minor] backfill 外側 catch が error 詳細を握り潰す** — `mirrorCoordinator.ts` の `startBackfill` 外側 catch が
  `sink.statTranscript` / `repo.get` / upsert 例外を `failedSessions++` のみに反映し `last_error` を残さない
  （refuse/通常同期経路は recordError で残す）。D-5「silent failure 禁止」の観点で診断情報が失われる。
  修正案: 外側 catch でも `recordError(sessionId, root, err)` を呼んでから failed++。
- **[minor] `computeResumeVerificationRange` の destSize=0 エッジ** — destSize=0 かつ recordedSyncedBytes>0 のとき
  照合窓が空になり、「宛先が外部削除された（本来 suffix を持つはず）」ケースと「skip 後まだ何も書いていない正当ケース」を
  区別できず楽観採用する。M6 相当挙動で新規回帰ではないが、削除された宛先へ offset0 追記すると先頭欠落し得る。
  修正案: destSize=0 かつ recordedSyncedBytes>0 を「再バックフィル要求」状態として区別することを検討、または仕様許容を doc 明記。

## minor（i18n — 防御的 throw 文言の残余）

- **[minor] 英語のままの防御的 throw 文言** — `fsSink.ts:58`（append-only 違反ガード）、`fsSink.ts:25`（sessionDir "refusing to mirror…"）、
  `spoolReader.ts`（"invalid session id" / "short read"）。いずれも `recordError` 経由で `last_error` として日本語 UI に露出し得る
  （通常運用では近似到達不能な防御パス）。acceptance が明示した2箇所（プローブ errno / mirrorPlan reason）は解消済みで基準は充足だが、
  ミラー系文言の完全な日本語統一としては残余。修正案: `describeProbeErrno` 同様、日本語リード文＋原文括弧温存。

## minor（UX）

- **[minor] StatusBar 起点で開いた後に root 解除するとフォーカスが body へ落ちる** — `App.tsx:79` は
  `mirrorIndicatorButtonRef.current?.focus()` だが、`MirrorIndicator` は `outputRoot!==null` のみ mount。
  StatusBar から開きダイアログ内で「解除」して閉じるとインジケータ unmount 済みで ref が null → focus が body へ逃げる。
  修正案: ref 失効時はヘッダボタン等へフォールバック。
- **[minor] バックフィル長時間予告が初回進捗到着で消える** — 「数分以上かかる場合があります」が `backfillStarting && !backfillProgress` の窓のみ。
  進捗表示に切替わると予告が消え、大量セッションでは進捗中の所要見込みが得にくい。修正案: 進捗表示側に控えめな継続注記。

## minor（構造・テスト）

- **[minor] retryTimers/retryDelays が sessionId 単独キー** — `mirrorCoordinator.ts:436-450`。M7 で retry 対象が
  verify(rebaseline) と sync(runOnce) の2種になり、同一 session の両者が互いのタイマーを上書きし得る
  （派生状態の自己修復範囲で害小）。修正案: operation 種別を含むキー化、または設計意図をコメント固定。
- **[minor] `rebaselineSession` の sink 冒頭捕捉と root 引数の非対称にコメントが薄い** — `mirrorCoordinator.ts:208`。
  sink は entry 捕捉、root は引数（per-(session,root) 呼び出しゆえ意図的で安全）。将来の読者の二度見を防ぐ1行注記があるとよい（修正不要級）。
- **[minor] FakeDatabase.transaction は真の rollback を模擬しない（既知の制約）** — `schema.test.ts:42-51`。
  マイグレーションの原子性（crash-rollback）は SQLite/better-sqlite3 のセマンティクスに依存し、本 harness の
  FakeDatabase では unit 検証しきれない。テストが固定するのは「残存中間テーブルからの再実行が壊れない」観測可能不変条件のみ。
  実 better-sqlite3 が vitest 下で load 不可（Electron ABI）という環境制約に由来。修正案: E2E 層での起動時マイグレーション検証を将来検討。
