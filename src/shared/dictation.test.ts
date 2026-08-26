import { describe, expect, it } from 'vitest'
import { resolveDictationKeyAction, type DictationKeyInput } from './dictation'

function input(overrides: Partial<DictationKeyInput>): DictationKeyInput {
  return {
    text: 'hello',
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    ...overrides
  }
}

describe('resolveDictationKeyAction', () => {
  it('returns none for a key other than Enter/Escape (e.g. plain typing)', () => {
    expect(resolveDictationKeyAction(input({ key: 'a' }))).toEqual({ kind: 'none' })
  })

  it('Enter with normal text submits the normalized (one-line) text', () => {
    expect(resolveDictationKeyAction(input({ key: 'Enter', text: 'fix the bug' }))).toEqual({
      kind: 'submit',
      text: 'fix the bug'
    })
  })

  it('Enter collapses internal newlines the same way normalizeInitialPromptText does', () => {
    expect(resolveDictationKeyAction(input({ key: 'Enter', text: 'a\nb' }))).toEqual({
      kind: 'submit',
      text: 'a b'
    })
  })

  it('Enter on empty text does not submit', () => {
    expect(resolveDictationKeyAction(input({ key: 'Enter', text: '' }))).toEqual({ kind: 'none' })
  })

  it('Enter on whitespace-only text does not submit', () => {
    expect(resolveDictationKeyAction(input({ key: 'Enter', text: '   \n  ' }))).toEqual({
      kind: 'none'
    })
  })

  it('Shift+Enter does not submit or insert (caller lets the newline land in the textarea)', () => {
    expect(
      resolveDictationKeyAction(input({ key: 'Enter', shiftKey: true, text: 'a' }))
    ).toEqual({ kind: 'none' })
  })

  it('Ctrl+Enter inserts (paste only, no CR) rather than submitting', () => {
    expect(
      resolveDictationKeyAction(input({ key: 'Enter', ctrlKey: true, text: 'a\nb' }))
    ).toEqual({ kind: 'insert', text: 'a b' })
  })

  it('Ctrl+Enter on empty/whitespace-only text does not insert', () => {
    expect(
      resolveDictationKeyAction(input({ key: 'Enter', ctrlKey: true, text: '  ' }))
    ).toEqual({ kind: 'none' })
  })

  it('Meta+Enter (Cmd, mirrors Ctrl) inserts rather than submitting', () => {
    expect(
      resolveDictationKeyAction(input({ key: 'Enter', metaKey: true, text: 'a' }))
    ).toEqual({ kind: 'insert', text: 'a' })
  })

  it('IME composition Enter (isComposing) does not submit even without modifiers', () => {
    expect(
      resolveDictationKeyAction(input({ key: 'Enter', isComposing: true, text: 'あ' }))
    ).toEqual({ kind: 'none' })
  })

  it('IME composition Ctrl+Enter also does not insert', () => {
    expect(
      resolveDictationKeyAction(
        input({ key: 'Enter', ctrlKey: true, isComposing: true, text: 'あ' })
      )
    ).toEqual({ kind: 'none' })
  })

  it('Escape requests a focus handoff back to the terminal', () => {
    expect(resolveDictationKeyAction(input({ key: 'Escape' }))).toEqual({ kind: 'focusTerminal' })
  })

  it('Escape during IME composition still hands focus back (composition has nothing to do with Escape)', () => {
    expect(
      resolveDictationKeyAction(input({ key: 'Escape', isComposing: true }))
    ).toEqual({ kind: 'focusTerminal' })
  })
})
