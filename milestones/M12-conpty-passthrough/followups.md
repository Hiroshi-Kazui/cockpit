# M12 残課題（followups）

反復2 で4体 PASS（code 93 / architect 91 / usability 88 / requirements 88）となった時点の
未解消 non_blocking。すべて blocking ではない。severity 順。次回 `/cockpit-plan` が参照する。

## major（本 M の完了に直結）

- **[major] M12 の効果が対照実験で示せていない（R-5 実施済み・結果は `r5-verification.md`）** —
  実 claude で崩れは 0 件（40/40 intact、実行中 resize 44 回）だったが、**旧 OS ConPTY の対照条件でも
  0 件**。R-5 の文面（崩れが再現しないこと）は満たすが、本 M の中核仮説「同梱 ConPTY で崩れが消える」の
  証明にはなっていない。報告された崩れは cec54ae / 1a78edb で既に解消していた可能性がある（未確認）。
  一方で M12 には exit 通知 1.2 秒 → 3.4 秒という実測コストがある（下記）。
  **ユーザー判断（2026-08-11）: 「とりあえず使ってみてからの判断するしかない」→ 出荷する。**
  実運用で崩れの再発と exit 遅延の体感を見て、必要なら `COCKPIT_DISABLE_CONPTY_DLL=1` で戻すか
  新 ADR で supersede する。次回 `/cockpit-plan` は使用実感を踏まえて要否を再評価すること。
  判断材料を増やすなら、崩れを意図的に再現する陽性対照（判定ロジックが崩れを検出できることの検証）と、
  複数ジオメトリでの再試行が必要。

- **[major] 自然終了時の exit 通知が 1.2 秒 → 3.4 秒に伸びた** — `src/renderer/src/hooks/usePtyPane.ts:158-162`。
  usability が Electron 実機で実測（各3回）: 自然終了 → onExit は OS 版 1.11/1.26/1.12s に対し
  同梱 dll 版 3.50/3.43/3.45s。kill 経由は 0.08〜0.17s → 1.69〜1.74s。
  その間ペインは「実行中／停止」表示のままで、打鍵は死んだ pty に**例外なく吸われる**
  （死亡後 1.5 秒時点の `write()` が成功することを実測）。停止ボタン経路は `stop()` の楽観更新で
  体感被害が小さいが、自然終了（`/exit`・クラッシュ）は完全に待たされる。
  修正案: main 側で子プロセスハンドルを別途監視して pty の exit イベントを待たずに `running` を落とす
  （通知行の文言は従来どおり exit イベントで書く）。ADR-0014「帰結」に実測値を残す。

- **[major] どちらの ConPTY で動いているかが UI にも記録にも現れない** — `src/main/pty/ptyRecorder.ts:14-18`、
  `src/main/pty/windowsPtyInfo.ts:101-104`。`describeHostWindowsPty()` は両モードで同一の
  `{backend:'conpty', buildNumber}` を返し、recorder の `spawn` イベントにもフラグがない。
  結果 (1) シェルに `COCKPIT_DISABLE_CONPTY_DLL=1` が残ったまま起動すると旧バックエンド＝崩れ再発状態に
  無言で戻り原因を判別できない、(2) R-5 の recorder ログを後から見てもホスティングを特定できない。
  D-2 の逃げ道が「効いたことを確認できる」ことが前提なので実効性に関わる。usability が2反復で提起。
  修正案: `PtyRecordEvent` の `spawn` に `useConptyDll` を追加（append-only の形式追加のみ）＋
  spawn 時に main のログへ1行出す。

- **[major] `describeWindowsPty` の第3引数が死んだパラメータ** — `src/main/pty/windowsPtyInfo.ts:89-100`。
  `void useConptyDll` で捨てられ結果に寄与しない。ADR-0014 D-3 の「1関数から導出」を実際に担保しているのは
  `resolveHostUseConptyDll()` への集約と `describeHostWindowsPty()` の呼び出し関係であり、
  引数自体は呼び出し側に同一値を強制しない。全テスト呼び出しに無意味な引数を強いるコストは実在。
  acceptance R-2 が signature を明文要求したため今回は妥当。architect（2反復）・code が指摘。
  修正案: R-5 確定後に「dll 由来の能力/版を反映して load-bearing にする」か「引数を落として
  `resolveHostUseConptyDll` への集約をコメントで示す」かを再判断する。

- **[major] 環境変数の読み取りが合成ルートではなく PtyManager 内にある** — `src/main/pty/ptyManager.ts:122`。
  同ディレクトリの先例 ptyRecorder は `src/main/index.ts:294` で `createPtyRecorderFromEnv(process.env)` を
  評価し `PtyManagerDeps` として注入する。M12 は `resolveHostUseConptyDll()` 経由で `process.env` を暗黙参照し、
  既存の注入の縫い目（`ptyManager.ts:17-27`）を使っていない。症状として `ptyManager.test.ts:327-337` が
  グローバル `process.env` の退避・復元を強いられている（`windowsPtyInfo.test.ts:21` は env を渡すだけ）。
  architect が指摘。修正案: `PtyManagerDeps` に `useConptyDll: boolean` を追加し index.ts で注入。
  規則の所有は windowsPtyInfo のままで D-3 の単一化は保たれる。

- **[major] 既存 E2E 3本が失敗している（M12 起因ではない）** — `e2e/evaluation.spec.ts`（Escape で
  `.evaluation-settings` が閉じない）、`e2e/git-sync.spec.ts:99`（アラート detail に repoDir が含まれない）。
  `COCKPIT_DISABLE_CONPTY_DLL=1`（旧 ConPTY）で同一箇所が同一に失敗することを requirements が A/B 確認済みで、
  失敗地点も pty spawn 前の設定ダイアログ／git アラート文言。acceptance R-4「スイート全体 green」を
  字義どおりには満たさないが M12 の差し戻し理由にはしない。
  修正案: 既存不具合として別途調査する。

## minor（診断性・文書）

- **[minor] `COCKPIT_DISABLE_CONPTY_DLL` の誤値が無言で無視される** — `src/main/pty/windowsPtyInfo.ts:55`。
  `'true'` 等と打ち間違えると退避スイッチが効かないまま新挙動で動くが、利用者に何も伝わらない。
  既定を新挙動に倒す判断自体は妥当（コメント・テストで明示済み）。code が指摘。
  修正案: 未設定でも `'1'` でもない値のとき起動時に1回だけ warn を出す（値と採用した挙動を明記）。

- **[minor] conpty.dll 欠落時のメッセージが node-pty 生のまま** — `src/main/pty/ptyManager.ts:111-123`。
  usability が実測: `build/Release/conpty` を退避すると
  `Cannot find conpty.dll at C:\...\build\Release\conpty\conpty.dll, error code: 3` を throw し、
  `purposeCoordinator.ts:128-132` → `Pane.tsx:329-333` の `.pane-error`（role="alert"）に出る
  （silent failure ではない）。ただし復旧手順（`npm run rebuild`）にも `COCKPIT_DISABLE_CONPTY_DLL=1` にも
  触れず、claude 未検出のような起動時プリフライト（`App.tsx:287-291`）も無いため 4ペイン全滅から復帰しにくい。
  修正案: 例外を捕捉して回復手順を添えて再 throw するか、README「既知の環境依存の問題と対処」へ追記。

- **[minor] README / ADR に rebuild の新ステップが未記載** — `package.json:18` / `README.md:49-50` /
  `docs/adr/0014-conpty-dll-hosting.md`。`electron-rebuild`（node-gyp rebuild = clean 込み）が
  `build/Release` を作り直し、node-pty 自身の postinstall が置いた `build/Release/conpty/conpty.dll` が
  失われるため post-install の再実行が必須。この理由がどこにも記録されていない。
  node-pty の私的スクリプトパスへの依存で、バージョン更新で消えても検知点がない。
  code・architect・requirements の3体が指摘。修正案: README のセットアップ節と ADR-0014「帰結」に各1行。

- **[minor] 停止操作でも `[claude exited: code=1]` と表示される** — `src/renderer/src/hooks/usePtyPane.ts:161`。
  同梱 dll の kill は常に `TerminateProcess(...,1)`（従来は `-1073741510`）。
  ユーザーが自分で押した停止なのにエラー終了に見える。usability が指摘。
  修正案: `stop()` 起点の終了は `[claude stopped]` 等に文言を分ける
  （アプリが書く行なので素通しには影響しない）。

- **[minor] 古い前提のコメントが残っている** — `src/main/pty/windowsPtyInfo.ts:16-18`、
  `src/renderer/src/hooks/usePtyPane.ts:75-81`。「情報行の出入りで実行中のペインの行数が変わるので
  この経路は通常利用で踏まれる」は 1a78edb（情報行を定数高の `.pane-info` に集約）以降**成立しない**。
  M12 の diff がこのコメント塊に触れているのに古い前提が残った。usability が指摘。
  修正案: 「cockpit 自身の実行中リサイズは無くなり、残るのはウィンドウリサイズ・分割線ドラッグのみ」に更新。

- **[minor] ソース検証コメントの網羅性が読者に確認できない** — `src/main/pty/windowsPtyInfo.ts:73-87`。
  `_useConptyDll` の読み取り箇所を3点しか挙げておらず、`startProcess`(L58) / `connect`(L89) /
  `resize`(L123) / `clear`(L130) が全て `if (this._useConpty)` 配下である旨に触れないため、
  「winpty では到達しない」の網羅性をコメント単体で追えない。requirements が指摘。
  修正案: 「残りの読み取り点は全て conpty 分岐内」の一文を足す。

- **[minor] test-first（red 先行）の証跡がリポジトリに無い** — M12 は未コミットで、
  実装者の報告（vitest `resolveUseConptyDll is not a function` / tsc `Expected 2 arguments, but got 3` の
  red を確認）以外に追える記録がない。acceptance R-2 の4項目め。requirements が2反復で指摘。
  修正案: M12 のコミットメッセージに red→green の順序を1行記録する。

- **[minor] exit 通知 E2E が自然終了経路を未カバー** — `e2e/app.spec.ts:258-303`。
  追加されたテストは停止ボタン（kill）経路のみで、遅延が最大かつ楽観更新の無い自然終了経路が未カバー。
  fake-claude は自走終了させられるので追加コストは小さい。usability が指摘。

- **[minor] 新テストに既存 assert との重複** — `src/main/pty/windowsPtyInfo.test.ts:70-86`。
  `26200/true` と `18308/true` は同ファイル `:37` / `:49` の既存 assert と重複（許容範囲）。
  architect が指摘。修正案: 不変条件の主張に必要な false 側2件へ絞る。

- **[minor] 型アサーションと E2E の重複** — `src/main/pty/ptyManager.test.ts:322-324` の
  `(call[2] ?? {}) as { useConptyDll?: boolean }` は実シグネチャ型で `as` を外せる。
  `e2e/app.spec.ts:258-303` のフォルダ選択〜起動 約25行は `archive-output.spec.ts:58-70` とほぼ同一で、
  `e2e/fixtures/electronApp.ts` に `startSession(page, app, cwd, purpose)` ヘルパを切り出せる。code が指摘。

- **[minor] モジュール名と責務のずれ** — `src/main/pty/windowsPtyInfo.ts:1`。
  「renderer 向け Windows 記述子」と「プラットフォーム非依存の spawn ホスティングポリシー」の2責務を持ち、
  `resolveHostUseConptyDll()` は win32 以外でも `ptyManager.ts:122` で常に評価される。
  architect が2反復で指摘。修正案: `ptyHosting.ts` 等へ改名（import は2箇所のみ、機械的）。

## ハーネス運用上の記録（M12 固有ではない）

- **レビュー中の `git stash` 事故** — 反復1 のレビュー中に M12 実装6ファイルが退避され、
  requirements が「実装が存在しない」と観測した。オーケストレータが `git stash pop` で復元。
  複数レビュアーが同一作業ツリーを同時に読むため、baseline 比較は `git show HEAD:<path>` で行い
  `git stash` は使わない、というルールを agent 定義に明記する余地がある。

- **ルート `npx tsc --noEmit` は何も検査しない** — `files: []` + references 構成のため。
  静的ゲートでは `npm run typecheck`（node/web/e2e の3構成）を使うこと。code が指摘。
