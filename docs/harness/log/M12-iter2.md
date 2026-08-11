# M12 反復2（2026-08-11）

## 変更ファイル（FIX のみ・最小差分）

`src/main/pty/windowsPtyInfo.ts` / `src/main/pty/windowsPtyInfo.test.ts` の2ファイルのみ。
挙動を変える式の追加はゼロ（`describeWindowsPty` は `void useConptyDll` のまま）。

1. 反復1 blocking の訂正: node-pty ソース検証コメントを実ソースに合わせて書き直し
2. トートロジーだった等価性テストを、閾値上下 × `useConptyDll` 真偽の4点で
   期待オブジェクトを直接 assert する形に置換

実装者は指示された文言（「winpty 経路でも挙動を変える」）をそのまま書かず、
自ら実ソースを調べて **「値は伝播するが、その dispose ガードは winpty では到達不能」**
（`kill()` の winpty 分岐 `windowsPtyAgent.js:162-179` は `_conoutSocketWorker.dispose()` を呼ばず、
呼ぶのは `if (this._useConpty)` 配下の `:151` / `:158` のみ）という、より精密で検証済みの記述を採用した。
CLAUDE.md 恒久ルール4 に沿った判断。

## 静的ゲート（実測）

`npm run typecheck`（node/web/e2e 3構成）0 / `eslint` 0 / vitest 45 files 757 tests green。
E2E: terminal-repaint 4/4、exit 通知テスト green。
（注: ルート `npx tsc --noEmit` は `files: []` + references のため実質何も検査しない。
正しくは `npm run typecheck`。M12 起因ではない既存構成の落とし穴として記録。）

## verdict

| reviewer | status | score | blocking |
|---|---|---|---|
| code | PASS | 93 | 0 |
| architect | PASS | 91 | 0 |
| usability | PASS | 88 | 0 |
| requirements | PASS | 88 | 0 |

**判定: 4体 PASS / score 全て 85 以上 → レビューゲート通過。**

code・architect・requirements の3体が独立に node-pty 1.1.0 の実ソースへ全引用行を照合し、
訂正後の記述（新たに追加された「winpty では到達不能」の主張を含む）が正確であることを確認した。
requirements は `dispose()` 呼び出し点を lib 全体で網羅探索し、他の呼び出し点が無いことも確認。

requirements は追加で、`ELECTRON_RUN_AS_NODE` + `tasklist /m conpty.dll` により
**`useConptyDll=true` のとき同梱 conpty.dll が実際にロードされ、false ではロードされない**ことを実測。
D-1 が無言の no-op ではないことが確認された。

## 出荷保留の理由

acceptance **R-5（実 claude CLI での実機確認）が未実施**。
本マイルストーンの中核仮説（同梱 ConPTY で表示崩れが消える）は未確認のままであり、
requirements も「R-5 の証跡が記録されるまで shipped にしない」を major で提起している。
`status: approved` のまま保持し、spec 更新も R-5 通過後に行う。
