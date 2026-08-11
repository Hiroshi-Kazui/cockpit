# M12 反復1（2026-08-11）

対象: milestones/M12-conpty-passthrough/（同梱 ConPTY / useConptyDll への切替）

## 変更ファイル

`src/main/pty/windowsPtyInfo.ts` / `windowsPtyInfo.test.ts` / `ptyManager.ts` / `ptyManager.test.ts` /
`e2e/app.spec.ts`（exit 通知テスト追加） / `package.json`（rebuild に node-pty post-install.js を追加）

## 静的ゲート（実測）

`tsc --noEmit` 0 / `eslint` 0 / vitest 45 files 757 tests green。
E2E: terminal-repaint 4/4 green、app.spec 5/5 green。evaluation/git-sync の失敗は
`COCKPIT_DISABLE_CONPTY_DLL=1`（旧 ConPTY）でも同一に再現し M12 起因でないことを A/B 確認。

## verdict

| reviewer | status | score | blocking |
|---|---|---|---|
| code | FAIL | 78 | 1 |
| architect | PASS | 90 | 0 |
| usability | PASS | 88 | 0 |
| requirements | PASS | 91 | 0 |

**判定: FAIL** → 反復2 へ。

### blocking（code）

`src/main/pty/windowsPtyInfo.ts:72-78` の node-pty ソース検証コメントが実ソースと矛盾。
「`_useConptyDll` is read only inside `if (this._useConpty)` branches / winpty fallback では一切参照されない」
と *Confirmed* で断定していたが、`windowsPtyAgent.js:74` の `new ConoutConnection(term.conout, this._useConptyDll)`
は分岐外で実行され winpty 経路にも値が渡る（`windowsConoutConnection.js:93` が読む）。
acceptance R-2 最終項が要求する検証成果物そのものの誤り。requirements も独立に同一箇所を minor で検出。

## 事故記録

レビュー中（17:22 頃）、M12 実装6ファイルが何者かの `git stash` で作業ツリーから退避された。
requirements が検出・報告し、オーケストレータが `git stash pop` で復元（`ptyManager.ts:122` に
`useConptyDll` が戻っていることと、復元後の tsc 0 / vitest 757 green を実測確認）。
稼働中の2レビュアーへ「stash 禁止・stash 中の観察は破棄して読み直し」を通達。
usability は「stash は未実行、観察は全て実装ありの状態」と回答。実行主体は未特定。
