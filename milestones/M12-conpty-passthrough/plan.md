---
milestone: M12
title: pty ホスティングを node-pty 同梱 ConPTY（useConptyDll）へ切替え、表示崩れの発生機構を根絶する
status: shipped   # draft → approved（/cockpit-build 起動 = 承認イベント）→ shipped（品質ゲート合格）
created: 2026-08-11
decisions: docs/adr/0014-conpty-dll-hosting.md
---

# M12 — pty ホスティングを同梱 ConPTY（useConptyDll）へ切替える

## 1. 背景・要望

> 今までは対処療法的な措置しかしてきませんでした。今回の提案もそうです。
> もっと根本的な、今までとは全く異なる表示方法ができないものか

（2026-08-11 セッションでのユーザー発言。スクロール/再描画時の「左端の文字が1文字分左にずれ、
行頭に前の行の文字が残る」崩れに対する `windowsPty` 設定・情報行の定数高化（1a78edb）・
`convertEol` 除去（cec54ae）という一連の個別対処を受けての要件）

提示した2案のうち、spec §4.1（生 pty 素通し）を保ったまま発生機構を消せる
**案A（node-pty 同梱 conpty.dll への切替）** を本マイルストーンとする。
案B（stream-json 自前描画）は製品の再設計になるためスコープ外（ADR-0014 で却下記録）。

### 前提の実測（2026-08-11）

- node-pty 1.1.0 インストール済み。`third_party/conpty/1.23.251008001/win10-x64/` と
  `prebuilds/win32-x64/conpty/` に conpty.dll + OpenConsole.exe が存在
- `IWindowsPtyForkOptions.useConptyDll?: boolean`（EXPERIMENTAL、既定 false）が typings に存在
- patch-package の node-pty patch は binding.gyp のみで干渉しない
- **崩れ解消の効果は未実測**。R-5 の実機確認で確定するまで仮説（ADR-0014 D-1 注記）

## 2. 要件

- **R-1（spawn 切替）**: `PtyManager.spawn()` が `useConptyDll: true` で pty を起動する。
  環境変数 `COCKPIT_DISABLE_CONPTY_DLL=1` のときのみ従来の OS 版 ConPTY に戻す（ADR-0014 D-2）
- **R-2（hostInfo の整合）**: renderer へ報告する `windowsPty` が spawn 側の実際の選択と
  常に一致する。選択ロジックは1箇所に置き二重実装しない（ADR-0014 D-3）
- **R-3（既存挙動の維持）**: pty ライフサイクル（spawn/write/resize/kill、exit 通知
  `[claude exited: code=…]`、respawn 世代ガード）の既存 unit テストが green のまま
- **R-4（E2E 回帰）**: `e2e/terminal-repaint.spec.ts` の4テストが同梱 ConPTY 上で green。
  既存 E2E スイート全体も green
- **R-5（実機確認）**: 実 claude CLI でスクロール（PageUp/ホイール）・ウィンドウリサイズ・
  分割線ドラッグを含むセッションを実施し、報告された崩れ（左ずれ・行頭残り）が再現しないこと。
  `COCKPIT_PTY_LOG_DIR` の recorder で生ストリームを取得し検証可能にする

## 3. 設計判断の要旨（本文は ADR-0014）

- 同梱 conpty.dll（WT 1.22 系アーキテクチャ）で conhost の翻訳・repaint 層を除去する（D-1）
- 環境変数による明示フォールバックを持つ。UI 設定にはしない（D-2）
- `windowsPtyInfo.ts` は「node-pty の既定規則の鏡写し」から「spawn に渡した事実の鏡写し」へ（D-3）
- useConptyDll が winpty fallback 時に無視されることの検証は実装時に node-pty ソースで行う（未検証）

## 4. 実装フェーズ

1. **windowsPtyInfo の拡張**（純関数、test-first: red 確認 → green）—
   「useConptyDll 有効/無効 × ビルド番号」から backend / buildNumber を導出する単一関数へ。
   spawn 側もこの関数（または同一モジュールの判定）から選択を得る形にする
2. **ptyManager の切替**（unit）— spawn オプションへの `useConptyDll` 付与と
   `COCKPIT_DISABLE_CONPTY_DLL` の分岐。node-pty は既存テスト同様 mock し、
   渡されたオプションを assert する
3. **E2E 回帰** — 既存スイート全走（terminal-repaint 4本を含む）。E2E は実 node-pty を使うため
   同梱 ConPTY 経路が実際に通る
4. **実機確認（R-5）** — 実 claude CLI で崩れシナリオを再走し、recorder ログとともに結果を記録

## 5. リスク

- useConptyDll は EXPERIMENTAL。node-pty 内部で kill / exit-code / clear / conout dispose の
  処理系が分岐する（実測: windowsPtyAgent.js:137-156, 224-240）→ R-3/R-4 で固定してから切替
- **R-5 で崩れが再現した場合、本マイルストーンの前提（仮説）が崩れる** → ビルドループは
  BLOCKED として停止しユーザーに諮る（勝手に案B へ転進しない）
- シャットダウン・強制終了時の挙動差（ConoutConnection の dispose 分岐）が
  E2E の closeApp 経路で顕在化する可能性
- 将来のパッケージング時に conpty.dll / OpenConsole.exe の同梱が必要（現状 dev 実行のみ。ADR-0014 帰結）

## 6. スコープ外

- 案B（stream-json 自前描画）
- @xterm/addon-unicode11 の追加（R-5 実測後に必要なら別マイルストーン）
- フォント（CJK フォールバック）起因の視覚上のずれ
- 既出荷の対処（windowsPty 報告・定数高情報行・convertEol 除去）の撤去 —
  同梱 ConPTY 上でも無害であり、撤去は R-5 で効果確定後の別判断

## 7. followups の取り込み

M6〜M11 の followups.md を確認。端末表示・ConPTY に関連する項目は無く、今回の取り込みは無し。
