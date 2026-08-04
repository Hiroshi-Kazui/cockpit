# M10 残課題（followups）

ビルドループ終了時（2026-07-27、反復3で4体 PASS）に残った non_blocking。
次回 `/cockpit-plan` が起案時に参照する。すべて blocking ではない（合格を妨げない）。severity 順。

## major（正しさ・残存する重複経路）

- **[major] `scan` 経路で `uuid` 無し保持行が 1 回重複追記される** — `src/main/archive/archiver.ts:267-272`、
  `src/shared/archiveRetention.ts:259`。錨は「`uuid` を持つ最後の行」なので、錨より後ろにある
  「保持されたが `uuid` を持たない行」は `scan` 復帰時に再追記される（`onError` なし）。
  **ADR-0011 D-4 の起案時前提「`uuid` 無し行は全て破棄対象」は実測で反証済み**:
  `~/.claude/projects` 581 ファイルに保持かつ `uuid` 無しの行が 1,349 行実在
  （`agent-name` 1,332 / `frame-link` 10 / `custom-title` 7 — いずれも denylist 未収載で D-3 により保持）。
  「最後の保持行が `uuid` 無し」だったのは 581 中 1 ファイル ≒ 0.17%。重複は次回以降サイドカーが
  錨と一致するため 1 回で収束し、取りこぼし・既存内容の破壊・append-only 違反は伴わない。
  requirements が実機プローブ P4/P9 で再現（128B→175B、`agent-name` が 2 回）、code も一時テストで再現。
  修正案: `readArchiveAnchor` が錨より後ろの保持行数（または行テキスト）も返し、`scan` で求めた
  オフセットからその分だけソース側の保持行を読み飛ばす。併せて検知時に `onError` で可視化する。
  あるいは `agent-name` / `frame-link` / `custom-title` を denylist に追加して発生源を消す。

- **[major] 錨判定ルールが 2 箇所に別実装で存在する** — `src/main/archive/archiver.ts:93-124`
  （`readArchiveAnchor`・後方窓走査）と `src/shared/archiveRetention.ts:149-155`
  （`lastRetainedUuid`・行配列走査）。「アンカー = `uuid` を持つ最後の行（`uuid` 無し末尾はスキップ）」
  という再開設計の中核ルールが二重化している。**反復2の B2 も反復3の C2 もこの 2 実装の不一致が根因**で、
  今回は「食い違わないように両方を直した」だけでルール自体は一元化されていない。
  片方だけ将来変更されると同じ症状が 4 度目に再発する。architect 指摘。
  修正案: ルールを `shared/` の 1 関数（例 `lastUuidOf(lines: readonly string[]): string | null`）に集約し、
  `readArchiveAnchor` は「後方窓を行配列に切り出して同じ関数に渡す」形へ還元する。

- **[major] `isSourceOffsetAtLineBoundary` の失敗写像が過剰** — `src/main/archive/archiver.ts:210-223`。
  「境界を確認できない」（ソース不在／ソースがオフセットより短い）を「アーカイブ破損」と同じ
  `unsafe`（恒久停止＋開発者へ報告のバナー）に写像している。`syncChunk:428-437` は同じ
  「ソースが縮んだ」を報告のみで watch 継続にしており、**同一異常に 2 方針が同居**。
  architect の実測ではソースが後から生成されても追記を拾わない。
  修正案: 「オフセットが行中を指す」（構造的 → `unsafe`）と「ソース不在／短い」（一過性 →
  `onError` 報告＋watch 継続、次の change で再評価）を分離する。

- **[major] 錨 `uuid` がソースに見つからない場合の byte 0 フォールバック** —
  `src/main/archive/archiver.ts:379-387`。`onError` は出るが `unsafe` に寄せておらず、
  既アーカイブ分を丸ごと再追記しうる。plan §3 / ADR D-4 の「欠落より重複」という明示的
  トレードオフには従っているが、`unsafe` 経路が新設された今は refuse の方が一貫する。
  requirements が P5 で経路到達を実機確認。
  修正案: `unsafe` に寄せるか、少なくとも「アーカイブに既存内容がある場合の 0 復帰」を禁止する。

- **[major] `unsafe` に復帰手段がない・状態が永続化されない** —
  `src/main/archive/archiver.ts:278-280, 350-360`。当該セッションのアーカイブ記録は恒久停止し、
  アプリ内の復帰操作がない。`attach` は `archivePath` を返すだけで「拒否中」状態がどこにも記録されず、
  `detach` は no-op、セッション行は更新されない `jsonl_path` を持ち続ける。再起動後は無警告。
  修正案: archiver の session map に refusing 状態を持たせ、status/UI が区別できるようにする。
  UI から確認・リセットできる経路を設ける。

## major（パフォーマンス・コメントの虚偽）

- **[major] 1MB チャンク化はイベントループのブロックを緩和していないのに、コメントは緩和したと主張** —
  `src/main/archive/archiver.ts:512`（`syncOnce`）。`while (this.syncChunk(...)) {}` の同期ループで
  チャンク間に yield が無いため、N 個のチャンクが 1 ターン内で連続実行される。抑えられたのは
  ピークメモリのみ。usability の実測（pre-M10 HEAD との同条件比較）:

  | ケース | pre-M10 | 現在 |
  |---|---|---|
  | 27MB / 6,734 行 attach | 108ms | 157 / 203 / 291ms |
  | 85.7MB attach | 374ms | 482ms |
  | 4ペイン同時 attach（計 306MB） | 2,163ms | 1,722ms |
  | ライブ追記再生（150 行 × 45 回） | 最大 ~19ms | 最大 39〜76ms |

  行ごとに `JSON.parse` が 2 回（`shouldRetainLine` ＋ `parseJsonlLine`）走るぶん単体では
  pre-M10 より重く、4ペイン大規模時のみ書き込み量 306MB→15MB の効果で逆転する。
  main のブロックは pty データ送出とキーストローク転送を止める（spec §4.1）ため、
  `/resume` 直後に 0.2〜0.5 秒の入力/描画停止として現れる。既出荷挙動と同種・同程度なので
  blocking ではないが、`archiver.ts:39-45` と `:412-419` のコメントは**コードが実現していない主張**。
  修正案: チャンク間で `setImmediate`/`await` して yield するか、コメントを
  「ピークメモリのみを抑える」に訂正する。

## minor（UX）

- **[minor] `unsafe` バナーの次アクションが cockpit の操作に対応づいていない** —
  `src/main/archive/archiver.ts:354`。「新しいセッションを開いて作業を続けてください」と言うが、
  脱出には新 `session_id` が必要（そのペインで `/clear` かペイン再起動。`/resume` で同じ id に
  戻ると再発）。またこの状態ではそのペインのトークン表示も以後更新されない（`onEntries` が
  二度と発火しない）ことに触れていない。
  修正案: 「そのペインで `/clear` を実行するか、ペインを再起動してください」と、
  記録・トークン表示が止まる旨を明記する。

- **[minor] `unsafe` バナーの折り返しが端末ジオメトリを動かす** — `src/renderer/src/styles.css:295-300`。
  `.pane-warning` に折り返し制御がなく、約 160 字のメッセージが 2〜4 行に折り返してヘッダが伸び、
  `flex:1` の xterm が縮んで pty リサイズ ＝ CLI 出力の再フローを引き起こす。
  修正案: 1 行省略（全文は既に `title` 属性にあるのでツールチップで読める）。

- **[minor] 記録停止が `role="status"`（polite）の 11px 黄色帯 1 行のみ** —
  `src/renderer/src/components/Pane.tsx:199-203`。不可逆イベントなのにペイン本体は通常どおり動作し、
  トークンも 0 のまま表示されるため「記録が止まった」ことが判別できない。バナーは一度出ると
  回復後も消えない。修正案: 停止系は `role="alert"`、テレメトリ行に「記録停止中」を出す、
  次回同期成功時にクリアする。

## minor（人間入力の取りこぼし・解析価値は低い）

- **[minor] `queue-operation` / `last-prompt` にしか無い人間入力** —
  `src/shared/archiveRetention.ts:57-66`。usability の実データ調査:
  bash モード入力（`!git rebase origin/main`、`!gh auth refresh` 等 5 件）は `last-prompt` にのみ存在
  （`system/local_command` は `<local-command-stdout></local-command-stdout>` だけで破棄）。
  `/model opus|sonnet|fable` 4 件と "do." 1 件は `queue-operation` の enqueue にのみ存在。
  いずれもコマンドであり自由記述の発話ではないので解析価値は低い。
  修正案: `queue-operation` の `operation:"enqueue"` かつ `content` 非空のみ保持
  （H: で 372 行 0.36MB、大半は task-notification）で D-3 の「保持に倒す」と整合させる。

- **[minor] 失敗した `tool_result` も破棄される** — `src/shared/archiveRetention.ts:63`。
  `is_error:true` 36 行 ＋ `toolUseResult.stderr` 非空 16 行 ＝ 実データ 61MB 中 122KB（0.2%）。
  「何が起きたか」を追う手掛かりになる。なお usability が `~/.claude/projects` 2.2GB 全量で
  確認した結果、`tool_result` に人間の自由記述は 0 件（"the user said:" を含む 44 件はすべて
  CLI 定型文）なので、人間発話の保全という観点では破棄して問題ない。
  修正案: エラーを含む `tool_result` 単独行だけ保持する例外を設ける（削減率への影響は無視できる）。

## minor（構造・テスト・文書）

- **[minor] `archiveRetention.ts` が 2 責務** — 選別ポリシー（15-120 行）と再開状態機械
  （122-279 行: `extractUuid` / `lastRetainedUuid` / `parseSidecar` / `ArchiveAnchor` /
  `ResumeDecision` / `decideResumeOffset`）が 3 反復連続で同居。`legacyArchiveSize` 削除分は
  `lastRetainedUuid` 追加で相殺され比重は軽くなっていない。
  修正案: `shared/mirrorPlan.ts` の先例に倣い `shared/archiveResume.ts` へ後者を分離。

- **[minor] コメントに回帰史の散文が過大** — `src/main/archive/archiver.ts:39-44, 86-92, 130-148,
  320-349`、`src/shared/archiveRetention.ts:1-13`。「B1 fix」「C1 fix」「major fix #3」といった
  **リポジトリ内に一切存在しないレビュー反復ラベル**（`docs/` `milestones/` に grep 一致 0 件）と
  削除済みコードの経緯説明が実装の分量に匹敵し、現在の契約が埋もれている。
  CLAUDE.md「コメントも埋め草で膨らませない」に反する。
  修正案: 経緯は ADR-0011 に寄せ、コメントは現在の不変条件の宣言に絞る。

- **[minor] `attach` の doc が「never throws」と嘘をついている** — `src/main/archive/archiver.ts:209`。
  `existsSync` 後の競合や EACCES/EBUSY で `statSync`/`openSync` は throw しうる。`attach` は
  try/catch を持たず、例外は `src/main/telemetry/pipeServer.ts:65-69` で
  「failed to parse pipe message as JSON」という無関係な文言でログのみに落ちる。
  修正案: `attach` 全体を try/catch し `onError` へ寄せる、または doc を訂正。

- **[minor] `scanSourceForLastUuidOffset` が末尾改行なしの最終行を走査対象にしない** —
  ソースが途中で切れて錨行が最終行になった場合は null → byte 0 フォールバックで全量重複する
  （`onError` は出る）。修正案: ループ後の `pending` に対しても uuid 照合を行い、
  行末が未確定である旨を `onError` に含める。

- **[minor] `syncChunk` の 100ms ポーリングごとのサイドカー書き込み** —
  `src/main/archive/archiver.ts` の `writeFileAtomic`。オフセット未変化時のスキップ／デバウンス余地。
  temp 名が毎回変わる（pid+`Date.now()`）ため Windows で新規ファイル生成がポーリング頻度で発生し、
  Defender のスキャン対象になる。`renameSync` 失敗時（Windows の AV/インデクサによる EPERM）に
  `.tmp` が残り回収経路がない。修正案: 固定 temp 名を再利用し、attach 時に残骸を掃除する。

- **[minor] 削減効果 fixture が保持側の最大要素を写していない** —
  `src/shared/archiveRetention.test.ts`。`image,text` 行（実測 4.88MB / 287MB）と
  `queued_command` 行（30KB）が fixture に無く、削減率を実態より良く見せる。
  acceptance が要求する 4 カテゴリは充足しており、実データでも 9.26〜9.85% で 10% 未満は維持。
  修正案: 両行種を比例量で追加する。

## major（テスト観測点 — 反復5 の残余。ADR-0012 関連）

- **[major] `src/shared/testHooks.ts:21` が main の型プログラムへ DOM 由来の `Window` を注入している** —
  `declare global { interface Window }` が `src/shared/**/*.ts` glob 経由で `tsconfig.node.json`
  （`lib: ["ES2022"]`、DOM なし）にも入り、**反復5以前には存在しなかった `Window` グローバル型を生成する**。
  code と architect が独立に実測（DOM-less プログラムで `function probe(w: Window) { return
  w.__cockpitTestHooks?.readPaneText(0) ?? '' }` がエラーなく通る。差分前は `src/main/**` で
  `Window` 参照が compile error だった）。反復2で両者が指摘した「`shared/` に Node ランタイム依存
  （`Buffer.byteLength`）を持ち込むな」の型方向版。型のみで実行時フットプリントはゼロ。
  修正案: `src/renderer/src/testing/testHooks.d.ts` へ移し `tsconfig.web.json` / `tsconfig.e2e.json` の
  `include` に明示列挙する（`src/preload/index.d.ts` を両方に個別 include している既存前例と同型）。
  契約1箇所を保ったまま main の型プログラムを中立に戻せる。

- **[major] `readPaneText` が soft-wrap を無視している** —
  `src/renderer/src/testing/terminalProbe.ts:40`。xterm は折り返した論理行を複数 buffer line として
  保持し継続行は `line.isWrapped === true` になるが、現実装は全行を無条件に `'\n'` で join するため、
  ペインの桁数を超える応答では**文字列の途中に偽の改行が入り** `toContain` が静かに落ちる。
  現在は未発火（assert は single レイアウト 1400px ≈ 150 桁で走り、最長の対象文字列は ≈ 72 桁）だが、
  ADR-0012 は本観測点を「将来の E2E 追加にも足りる」と宣言しており、折り返し出力に対して
  その主張は成立しない。修正案: `isWrapped` が true のとき直前要素へ連結する。

- **[major] cleanup 全体を単一 try/catch で包んだため先頭の失敗が後続を全スキップする** —
  `e2e/app.spec.ts:247` / `e2e/archive-output.spec.ts:252`。最後に置かれた
  `cleanupFakeClaudeTranscripts()`（`e2e/fixtures/electronApp.ts:141`）が消すのは temp ではなく
  **ユーザーの実 home `~/.claude/projects/cockpit-e2e`**。`rmDirWithRetry(scratchCwd)` が 5s で
  諦めた場合、実 `~/.claude` にフィクスチャ transcript が残り、記録は `console.error` だけで
  テストは green を報告する（cockpit のアーカイブ・解析対象を汚染しうる）。
  なお現時点で残骸が無いことは実測確認済み。`finally` が原エラーを潰さないようにする判断自体は正しい。
  修正案: cleanup をステップ単位でガードする（少なくとも実 home の cleanup を先頭か独立の try に）。
  `try` 本体が成功していた場合の cleanup 失敗はログではなくテスト失敗にする。

- **[minor] ADR-0012 の不変条件がソースから見えない** — `src/` `e2e/` 全体で `ADR-0012` の参照が 0 件。
  「本番バンドルから撤去してはならない」（撤去すると E2E が原理的に落ちる）が ADR にしか存在せず、
  実体は名前が刈り込みを誘う `src/renderer/src/testing/` 配下にある。
  修正案: `terminalProbe.ts` 冒頭コメントに「本番バンドルに意図的に含む（ADR-0012 D-2）」の1行を追加。

- **[minor] `terminalProbe.ts:48` のモジュールロード時副作用が無ガード** —
  `window.__cockpitTestHooks = hooks`。現状は無害（vitest は `environment: 'node'` かつ
  `src/**/*.test.ts` のみ収集、renderer テストは存在しない）だが、将来 `usePtyPane` を import する
  unit test を足すと import 時に ReferenceError。修正案: `typeof window !== 'undefined'` でガード。

- **[minor] unregister に同一性チェックが無い** — `terminalProbe.ts:29`。
  React の cleanup-before-next-effect 順序により今日は到達不能だが
  `if (registry[pane] === term) delete registry[pane]` が定石。

- **[nit] `readPaneText` が非 export で純変換部分に unit テスト面が無い** —
  検証は E2E 経由のみ。修正案: export して web の vitest で最小の変換テストを1本置く
  （xterm 型を renderer 側に閉じる配置自体は正しいので変えない）。

- **[nit] `e2e/app.spec.ts:178` のコメントが自己矛盾** — 旧稿の書き換え残り。

## E2E

反復4・反復5 で共通ゲートの red（2 failed）と flake（25%）は解消し、M10 の行選別も
E2E で検証されるようになった（`readPaneTerminalText` による xterm buffer 読み出し、
アーカイブ実体の直読み、破棄1種・保持1種の対での固定。決定は ADR-0012）。
残るのは以下。

- **[E2E] 再開経路（サイドカー / `scan` / `unsafe`）が E2E 未カバー** — `e2e/**` にアプリ再起動 →
  再アタッチを行う spec が存在しない（requirements が全数確認）。acceptance.md R-6 は全項目を
  「archiver / shared の unit テストで固定」と要求しており E2E は求めていないので**未達ではない**が、
  M10 の中核である再開が E2E で一度も通っていない。
  修正案: 「選別済みアーカイブでアプリを再起動し、重複も取りこぼしもなく追記が続く」シナリオを追加する。

- **[E2E] 破棄・保持の網羅が各1種のみ** — R-3 の 19 形状のうち E2E が通すのは `hook_success` 1 種、
  R-2 の保持側は `queued_command` 1 種（反復5で追加）。残りは unit のみ。
  修正案: 網羅は unit に委ね、E2E は代表形状の対で足りる、という線引きを acceptance に明記する。
