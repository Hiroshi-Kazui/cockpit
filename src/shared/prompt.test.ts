import { describe, expect, it } from 'vitest'
import { normalizeInitialPromptText } from './prompt'

describe('normalizeInitialPromptText', () => {
  it('leaves single-line text unchanged', () => {
    expect(normalizeInitialPromptText('fix the bug')).toBe('fix the bug')
  })

  it('collapses an internal newline (Shift+Enter in the textarea) to a single space', () => {
    expect(normalizeInitialPromptText('line one\nline two')).toBe('line one line two')
  })

  it('collapses \\r\\n and bare \\r the same way', () => {
    expect(normalizeInitialPromptText('a\r\nb')).toBe('a b')
    expect(normalizeInitialPromptText('a\rb')).toBe('a b')
  })

  it('collapses multiple consecutive newlines (blank lines) to a single space', () => {
    expect(normalizeInitialPromptText('a\n\n\nb')).toBe('a b')
  })

  it('absorbs horizontal whitespace surrounding a newline into the single replacement space', () => {
    expect(normalizeInitialPromptText('a   \n   b')).toBe('a b')
  })

  it("does not touch leading/trailing whitespace (trim stays the caller's responsibility)", () => {
    expect(normalizeInitialPromptText('  a\nb  ')).toBe('  a b  ')
  })
})
