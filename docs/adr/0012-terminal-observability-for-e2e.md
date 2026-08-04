# ADR-0012: canvas レンダラ採用に伴う端末可観測性の観測点

- 日付: 2026-07-27
- 状態: proposed（`/cockpit-build` の M10 出荷処理で accepted）
- 関連: spec §4.1（生 pty 入出力の素通し）、§6（回帰の正はテストスイート）、
  milestones/M10-archive-line-retention/（本決定が必要になった経緯）
- 先行: コミット e0780da（scroll 時の左端文字化けを防ぐため xterm を canvas レンダラーに切替）、
  fb4c253（端末サイズ確定後に canvas レンダラを装着し dimensions エラーを防ぐ）、
  149a0e7（再開オーバーレイを xterm canvas 層より前面にしクリック無効を解消）

## 文脈

xterm を canvas レンダラー（`@xterm/addon-canvas`）へ切り替えたことで、
**端末に何が表示されているかを DOM から観測する手段が構造的に失われた**。
canvas レンダラーはテキストを `<canvas>` に描画するだけで DOM ノードに置かないため、
`e2e/**` が使っていた `.pane-terminal` の `textContent` / `toContainText()` は原理的に通らなくなり、
`playwright test` が 2 failed の状態で放置されていた（`e2e/app.spec.ts` と
`e2e/archive-output.spec.ts`）。

帰結は 2 つあった。1 つは共通品質ゲート（`docs/harness/review-rubric.md` の合格条件 2）が
恒常的に red だったこと。もう 1 つは、その失敗が **`e2e/app.spec.ts` のアーカイブ内容 assert に
到達しないこと**を意味しており、アーカイブ経路がエンドツーエンドで一切検証されていなかったこと。

canvas レンダラー自体は差し戻せない（DOM レンダラーに戻すと上記 3 コミットが解決した
文字化け・dimensions エラー・オーバーレイのクリック無効が再発する）。したがって
**端末内容を外部から読む観測点を設ける**しかない。

## 決定

- **D-1（恒久的な観測点を設ける）**: 端末テキストの検証は DOM の `textContent` ではなく、
  xterm の buffer 読み出しで行う。そのための観測点を renderer 側に 1 つ設け、
  E2E からはそれを通じて端末テキストを取得する。これは M10 限りの回避ではなく、
  canvas レンダラーを使い続ける限り必要な恒久の観測点として扱う。

- **D-2（本番バンドルに常時含める）**: 観測点を `import.meta.env.DEV` 等でビルド時に落とさない。
  E2E は `electron.launch({ args: ['.'] })` で **`npm run build` 済みの本番バンドルを起動する**
  （`e2e/fixtures/electronApp.ts`）ため、ビルド時ゲートは「テストした成果物 ≠ 出荷する成果物」を
  生み、E2E が原理的に成立しなくなる。成果物同一性を優先する。

- **D-3（プロセス境界を弱めない範囲に限る）**: 観測点が露出するのは renderer 内で生成された
  xterm `Terminal` の内容だけであり、Node/Electron API・IPC ハンドルは一切含めない。
  `nodeIntegration: false` / `contextIsolation: true` / `sandbox: true`（`src/main/index.ts`）と
  preload の contextBridge（`src/preload/index.ts`）は無変更のままとする。
  **能力の増分はゼロである**: main world には `contextBridge.exposeInMainWorld('cockpit', api)` により
  既に `pty.write` を含む IPC 全面が存在しており、観測点が返すのは自プロセスが既に描画した
  テキストの読み取りだけなので、その能力は厳密に既存表面の部分集合である。

- **D-4（登録・解除の対で管理する）**: 観測点はリポジトリ既存の per-pane capability 登録の前例
  （`src/renderer/src/components/Pane.tsx` が `focus` を `PaneIndex` キーで登録し cleanup で解除する）と
  同じ形にする。DOM ノードへの野良プロパティ（expando）は取らない。参照のライフサイクルを
  `Terminal` の生存期間と一致させ、`dispose()` 済みインスタンスへの参照が残らないようにする。

- **D-5（契約は 1 箇所）**: 観測点の名前と形を renderer 側と `e2e/**` の両方に書かない
  （CLAUDE.md「IPC は型付き契約: channel 名と payload 型を1箇所で定義」と同じ原則）。
  バッファから文字列への変換は renderer 側の観測点に置き、E2E は文字列を受け取るだけにする。
  併せて `tsconfig.e2e.json` を `npm run typecheck` に連結し、`e2e/**` の型を CI ゲートに載せる
  （従来は tsconfig が存在するのにゲート外で、`eslint` も `parserOptions: { project: false }` の
  ため型認識 lint が無く、契約のドリフトをどのゲートも検知できなかった）。

## 却下した代替案

- **DOM レンダラーへ差し戻す** — e0780da / fb4c253 / 149a0e7 が解決した文字化け・
  dimensions エラー・オーバーレイのクリック無効が再発する。UX の後退と引き換えに
  テストの都合を優先することになる。
- **ビルド時フラグで観測点を落とす** — D-2 のとおり成果物同一性を壊す。
  さらにフラグを preload/IPC 経由で渡す案は、本番の IPC 表面をむしろ増やす。
- **main 側で pty 出力を観測する（既存 telemetry / pty `onData` を検証点にする）** —
  本番バンドルに観測点を入れずに済む唯一の代替だが、**「pty にバイトが流れた」ことは
  「端末に描画された」ことを証明しない**。canvas レンダラーへの切替で実際に起きた不具合
  （e0780da の左端文字化け、fb4c253 の dimensions エラー）はいずれも
  pty 出力が正常なまま描画側だけが壊れるものであり、pty 観測では検出できない。
  描画結果を観測できることが D-1 の存在理由そのものである。
- **canvas のピクセルを OCR / スクリーンショット比較する** — 脆く、失敗時の診断性が低い。
- **端末内容の検証を諦めてアーカイブ実体の assert だけにする** — pty 素通し（spec §4.1）は
  本アプリの中核要件であり、「入力が端末に出た」ことを検証できない E2E では回帰を守れない。

## 帰結

- `playwright test` が共通ゲートとして機能する状態に戻る。M10 の行選別も E2E で検証されるようになる
  （アーカイブ実体を直読みし、保持される行種と破棄される行種を対で固定する）
- 出荷バンドルにテスト用の観測点が常時含まれる。これは意図した決定であり、
  「テストコードが本番に混ざっている」として将来撤去してはならない（撤去すると E2E が原理的に落ちる）
- E2E が端末に対して問うのは常にテキストなので、この観測点は将来の E2E 追加にも足りる
- `e2e/**` が型ゲートに載るため、観測点の契約が変わればビルドで検知される
