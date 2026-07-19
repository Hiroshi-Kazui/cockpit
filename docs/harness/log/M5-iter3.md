# M5 — 反復3 記録（残 closable minor 3件を収束）

- 日付: 2026-07-20
- 実装: cockpit-implementer（FIX モード、反復2 の closable minor 3件）
- 静的ゲート（オーケストレータ実測）: tsc.node=0 / tsc.web=0 / eslint=0 / vitest **349/349 pass** / E2E **4/4 pass**（フォーカス順変更後も green） — green

## 変更ファイル（renderer のみ）
- `src/renderer/src/App.tsx` — `archiveButtonRef`（「過去セッション」ボタン ref）追加。`closeSessionBrowser`（useCallback）が close 直後に呼び出し元ボタンへフォーカス復元。全 close 経路（Escape/背景/✕）は `onClose` 一本に集約。
- `src/renderer/src/components/SessionBrowser.tsx` — (1) 旧 unmount 時フォーカス復元 useEffect（autoFocus 済み input を捕捉し no-op だった）を削除。(2) `.session-browser__transcript` に `tabIndex={0}`（キーボードスクロール可能化、既存 `FOCUSABLE_SELECTOR` が自動取り込み、巡回順 検索→一覧→本文→閉じる）。(3) 一覧矢印キーナビの `querySelectorAll('.session-browser__item')` を `useRef<Map<string,HTMLButtonElement>>`（session.id キー）＋`sessions` state を辿る方式へ置換（挙動同一・class 名ドリフト耐性向上）。

## 解消した minor（反復2 残）
- [code] フォーカス復元の対象確定 → 呼び出し元 App が `archiveButtonRef` を owns、全 close 経路で opener へ確実復帰。code 再レビューで解消確認。
- [usability] トランスクリプトの keyboard スクロール → `tabIndex={0}`＋既存 overflow-y:auto。usability 再レビューで解消確認。
- [architect] 矢印/Tab ナビの class セレクタ依存 → id キー ref-Map へ置換（自己クリーン・leak/stale なし）。architect 再レビューで解消確認。

## verdict 要約（反復3・全員 PASS）
| reviewer | status | score | blocking |
|---|---|---|---|
| code | PASS | 94 | 0 |
| architect | PASS | 96 | 0 |
| usability | PASS | 97 | 0 |
| requirements | PASS | 96 | 0（反復2 から不変・iter3 非関与） |

## ゲート判定: PASS。残 findings は全て非 defect の cosmetic のみ
- [code/architect nit] インライン callback ref が毎描画で detach→attach する churn。**両者「対応不要／任意」と明言**（correctness 影響なし。per-row の session.id を閉じ込めるため useCallback で綺麗に潰せず、gold-plating 回避）。→ 据え置き（非 closable-worthwhile）。
- [usability minor] トランスクリプトの専用 `:focus-visible` 枠（既定 ring で到達・発見は可能、**"nicety, not a defect"**）。→ 2行 CSS・無リスクで cleanly closable のため反復4 で収束。

## 次アクション: 反復4（focus-visible 枠のみ・literal zero-findings 収束）
