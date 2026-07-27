# M10 反復4 — E2E（playwright）の修復

日付: 2026-07-27 / 判定: **FAIL**（4体 PASS だが rubric ゲート4「score >= 85」未達）

## 経緯
反復3で4体 PASS（86〜92）だったが `playwright test` が 2 failed で rubric ゲート2 未達。
原因は M10 ではなくコミット済みの xterm CanvasAddon 化（`usePtyPane.ts:74`）で、canvas レンダラは
DOM にテキストを置かないため `.pane-terminal` の `toContainText` が原理的に通らない。
オーケストレータは勝手に waive せずユーザーへエスカレーションし、
**ユーザーが「E2E を修復してから M10 を出荷」を選択**したため修復した。

## 静的ゲート（実測）
`tsc --noEmit`（node/web）0 / `eslint --max-warnings=0` 0 / `vitest run` 546 passed /
`playwright test` **6 passed**（前回 failed の2件を含め全件 green）

## verdict サマリ

| reviewer | status | score |
|---|---|---|
| code | PASS | 90 |
| architect | PASS | **84** ← ゲート4 未達 |
| usability | PASS | 90 |
| requirements | PASS | 89 |

## 変更ファイル
`src/renderer/src/hooks/usePtyPane.ts`（本番コードへの E2E 用フック）/ `e2e/fixtures/electronApp.ts` /
`e2e/app.spec.ts` / `e2e/archive-output.spec.ts` / `e2e/fixtures/fake-claude.js`

## 主な確認事項
- **プロセス境界は無傷**（3体が独立に検証）: `sandbox:true` / `contextIsolation:true` /
  `nodeIntegration:false`（`src/main/index.ts:110-114`）と preload の contextBridge は無変更。
  露出物は renderer 内の xterm インスタンスのみで、main world は既に `window.cockpit` の
  IPC 全面（`pty.write` 含む）を持つため**能力増分ゼロ**
- **M10 の選別が E2E で検証されるようになった**。requirements が retention を無効化する
  mutation を注入して **assert が確実に red になること**を確認し、そのときマーカー行が
  アーカイブ1行目に現れたことで「破棄対象行が本当に `attach(offset 0)` → `syncOnce` →
  `shouldRetainLine` を通っている」ことまで立証（偽陽性ではない）
- **usability が canvas 関連の回帰なしを確認**: 差分は `term.open()` 直後の1プロパティ代入のみで、
  fb4c253（dimensions）/ e0780da（文字化け）/ 149a0e7（オーバーレイ層順）に干渉せず。
  app-shell E2E を自ら実行して 3 passed

## architect の major 3件（score 84 の理由）
1. 露出手段が DOM 野良 expando で、既存の per-pane capability 登録前例
   （`Pane.tsx:53-55` の register/unregister 対）と不整合。cleanup に解除が無く
   dispose 済み Terminal 参照が生存 DOM ノードに残る
2. `__cockpitTerminal` の契約が `usePtyPane.ts` と `e2e/fixtures/electronApp.ts` に二重定義。
   しかも `tsconfig.e2e.json` は存在するのに `npm run typecheck` に入っておらず、
   `eslint` も `project: false` で型認識 lint 無し ＝ **契約のドリフトをどのゲートも検知しない**
3. 「本番バンドルに常時テスト観測点を置く」という横断的決定が ADR/plan に未記録

## requirements の major（重要）
**`playwright test` は決定的に green ではない**: 実測 8 回中 2 回 red（25%）。
失敗は全 assert 通過後の `finally` 内 `fs.rmSync(scratchCwd)` の `EPERM`
（Windows が fake-claude の子 `node.exe` の cwd としてロック）。M5 由来。
しかも **`finally` の throw が try 内の元例外を破棄する**ため、この経路は本物の失敗原因を隠す。

## code / requirements が見つけたゲートの穴
- 到達不能コードを**どのゲートも検出しない**（typescript-eslint が `no-unreachable` を off にする一方、
  tsconfig が `allowUnreachableCode` 未設定。実測で 9 行の dead code が両ゲート exit 0 で通過）
- レビュー中、requirements のミューテーション試験の残骸が一時的にツリーに存在し 32 unit test が
  落ちていた（code が検知）。最終ツリーでは消えており grep 一致 0 をオーケストレータが確認
