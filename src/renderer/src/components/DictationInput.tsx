// M13 (ADR-0015): a pane-local, always-present dictation textbox below the terminal (R-1/D-3). Aqua
// Voice's Windows auto-insert does not reach xterm.js's hidden textarea (measured, ADR-0015 文脈), but it
// does reach a plain HTML textarea -- this component is that textarea, plus the key handling that decides
// whether a keystroke submits/inserts/does nothing (delegated entirely to the pure
// `resolveDictationKeyAction`, shared/dictation.ts). It never talks to xterm.js or IPC directly; all of
// that goes through the `sendText`/`focusTerminal` callbacks the caller (Pane.tsx) already owns via
// usePtyPane.
import { useState, type KeyboardEvent } from 'react'
import type { PaneIndex } from '@shared/ipc'
import { resolveDictationKeyAction } from '@shared/dictation'

interface DictationInputProps {
  paneIndex: PaneIndex
  running: boolean
  sendText: (text: string, submit: boolean) => void
  focusTerminal: () => void
}

export function DictationInput({
  paneIndex,
  running,
  sendText,
  focusTerminal
}: DictationInputProps): React.JSX.Element {
  const [text, setText] = useState('')

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    const action = resolveDictationKeyAction({
      text,
      key: e.key,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      // `KeyboardEvent.isComposing` (not React's own, deprecated `e.nativeEvent.isComposing` alias
      // quirks aside) reflects whether an IME conversion is still in progress -- an Enter that merely
      // confirms kanji/kana conversion must not also submit (ADR-0015 D-6).
      isComposing: e.nativeEvent.isComposing
    })
    switch (action.kind) {
      case 'submit':
        e.preventDefault()
        sendText(action.text, true)
        setText('')
        return
      case 'insert':
        e.preventDefault()
        sendText(action.text, false)
        setText('')
        return
      case 'focusTerminal':
        e.preventDefault()
        focusTerminal()
        return
      case 'none':
        // Shift+Enter (insert a literal newline) and an IME-composing Enter (confirm the conversion) both
        // fall here and are deliberately left to the textarea's own default behavior -- neither is this
        // component's to intercept.
        return
    }
  }

  return (
    <textarea
      className="pane-dictation"
      aria-label={`口述入力（ペイン${paneIndex + 1}・Enter で claude へ送信、Shift+Enter で改行、Ctrl+Enter で挿入のみ）`}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={handleKeyDown}
      disabled={!running}
      placeholder={running ? '口述入力（Enter で送信）' : 'セッション開始後に使えます'}
    />
  )
}
