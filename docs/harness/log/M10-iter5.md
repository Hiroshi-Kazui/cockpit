# M10 反復5 — architect major の解消と E2E flake の除去

日付: 2026-07-28 / 判定: **合格（マイルストーン出荷）**

rubric 上限（最大5反復）の最終反復。

## ゲート（すべてオーケストレータが実測）

| ゲート | 結果 |
|---|---|
| 1. `tsc --noEmit` / `eslint` | `npm run typecheck`（node/web/**e2e** の3プロジェクト）exit 0 / `eslint --max-warnings=0` exit 0 |
| 2. unit / E2E | `vitest run` **546 passed**（34 files） / `playwright test` **9 連続 6 passed**（オーケストレータ4回＋実装者5回。反復4時点は 8 回中 2 回 red） |
| 3. 4レビュアー PASS | **全員 PASS** |
| 4. score >= 85 | **全員充足** |

## verdict サマリ

| reviewer | 反復4 | 反復5 |
|---|---|---|
| code | PASS 90 | **PASS 87**（`window` 露出に前提が変わったため再レビュー） |
| architect | PASS 84 | **PASS 90** |
| usability | PASS 90 | 反復4のまま有効（差分は architect 指摘への対応で UX 面の変更なし） |
| requirements | PASS 89 | 反復4のまま有効 |

## 変更ファイル
`src/shared/testHooks.ts`（新規・契約を1箇所に）/ `src/renderer/src/testing/terminalProbe.ts`（新規）/
`src/renderer/src/hooks/usePtyPane.ts` / `e2e/fixtures/electronApp.ts` / `e2e/app.spec.ts` /
`e2e/archive-output.spec.ts` / `e2e/fixtures/fake-claude.js` /
`tsconfig.node.json` / `tsconfig.web.json` / `tsconfig.e2e.json` / `package.json`

M10 本体（`src/shared/archiveRetention.ts` / `src/main/archive/archiver.ts`）は反復3の PASS 版から
**無変更**（実装者が `git diff --stat` で確認、オーケストレータが `MUTATION-PROBE` の grep 一致 0 で確認）。

## architect major 3件の解消（本人が確認）

1. **露出手段** — `terminalProbe.ts` が `App.tsx:95-102` の `registerPaneFocus` と**構造的に同型**
   （`Partial<Record<PaneIndex, T>>` ＋ 真値で代入 / `null` で `delete`）。
   `usePtyPane.ts:108-109` は `registerPaneTerminal(paneIndex, null)` を **`term.dispose()` の前**に呼び、
   dispose 済みインスタンスがレジストリに残る経路がない。DOM expando は消えた
2. **契約の二重定義** — `XtermTerminalLike` / `XtermBufferLike` の grep 一致 0。契約は
   `src/shared/testHooks.ts` の1箇所のみで、e2e 側は文字列を受け取るだけ。
   `npm run typecheck` に `tsconfig.e2e.json` を連結。3 tsconfig に `allowUnreachableCode: false`
3. **ADR 未記録** — オーケストレータが **ADR-0012（canvas レンダラ採用に伴う端末可観測性の観測点）**を
   新規作成。却下した代替案4件を含む。architect の指摘を受けて
   「main 側で pty 出力を観測する」案の却下理由（pty 到達 ≠ 端末描画。canvas 切替で実際に起きた
   不具合はいずれも pty 正常のまま描画側が壊れるもの）を追記し、
   設計文書に混入していたレビュー過程の記述を削除

## `window` 露出のセキュリティ判定（code が独自検証）

**後退ではなく改善**と判定。
- `src/main/index.ts:110-114` の `nodeIntegration:false` / `contextIsolation:true` / `sandbox:true` は
  無変更。`setWindowOpenHandler` も `action:'deny'` のまま。preload の contextBridge 差分は M9 のみ
- **`Terminal` インスタンスは `window` から到達できない**。`registry` はモジュールスコープで、
  外部から参照できるのは文字列を返す `readPaneText` クロージャ1つだけ。
  `term.write()` による端末表示の偽装経路は存在しない。
  **反復4の DOM expando は `document.querySelector('.pane-terminal').<expando>` で live `Terminal` に
  到達できたので、今回の形は厳密に安全側への移動**
- ADR-0012 D-3「能力増分ゼロ」は `preload/index.ts:114-120` の既存 `pty.write` / `pty.onData` により裏付け。
  `readPaneText` が返す文字列は `pty.onData` が既に流している情報の部分集合。
  `src/**` に `dangerouslySetInnerHTML` / `innerHTML` / `eval` / `new Function` は 0 件

## flake の除去（requirements の major）
`rmDirWithRetry`（5s / 100ms poll、超過後 re-throw）で Windows の post-kill ディレクトリロックを吸収し、
`finally` 内 cleanup を try/catch で包んで cleanup 例外が try 内の本当の失敗を隠さないようにした。
**playwright 9 連続 green**（反復4は 8 回中 2 回 red）。
実 home `~/.claude/projects/cockpit-e2e` に E2E フィクスチャの残骸が無いことも
オーケストレータが実測で確認。

## E2E の検証力強化（他レビュアー指摘への対応）
- poll をメッセージ固有の応答文に（`了解しました` はスクロールバックに既存で初回 tick 偽陽性の恐れがあった）
- 全 poll に日本語 `message:` を付与
- `fake-claude.js` に**保持側の `queued_command` 行**を追加し、破棄（`hook_success`）と保持を**対で固定**
- ミラー出力にも `not.toContain('hook_success')` を追加（R-1 の「出力先にも現れない」を直接検証）
- `sessionId` の取得を `purposeText` での一意特定に（`rows[0]?.id` の単一セッション前提を撤去）
- `focusPaneTerminal` / `archivedTranscriptPath` / `rmDirWithRetry` を fixture へ共有化

## 出荷処理
- `milestones/M10-archive-line-retention/plan.md` を `status: shipped` に
- `docs/claude-multi-window-spec.md` を現在の姿へ更新（§4.4 の行選別・サイドカー・安全停止、
  §4.4.1 のミラー対象外、§7 に denylist 追従と `uuid` 無し保持行のリスク）
- `docs/adr/README.md` に ADR-0011 / ADR-0012 を索引
- 未解消 non_blocking を `milestones/M10-archive-line-retention/followups.md` に集約
