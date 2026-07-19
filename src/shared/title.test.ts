import { describe, expect, it } from 'vitest'
import { TITLE_MAX_LENGTH, buildTitlePrompt, sanitizeGeneratedTitle, truncateTitle } from './title'

describe('truncateTitle', () => {
  it('returns short text unchanged', () => {
    expect(truncateTitle('READMEを直す')).toBe('READMEを直す')
  })

  it('trims and collapses internal whitespace/newlines', () => {
    expect(truncateTitle('  hello   \n  world  ')).toBe('hello world')
  })

  it('returns empty string for whitespace-only input', () => {
    expect(truncateTitle('   \n\t  ')).toBe('')
  })

  it('leaves text exactly at the max length unchanged (boundary)', () => {
    const text = 'a'.repeat(TITLE_MAX_LENGTH)
    expect(truncateTitle(text)).toBe(text)
    expect(truncateTitle(text).length).toBe(TITLE_MAX_LENGTH)
  })

  it('clips text one character over the max length and appends an ellipsis (boundary)', () => {
    const text = 'a'.repeat(TITLE_MAX_LENGTH + 1)
    const result = truncateTitle(text)
    expect(result).toBe('a'.repeat(TITLE_MAX_LENGTH) + '…')
  })

  it('respects a custom maxLength', () => {
    expect(truncateTitle('abcdefgh', 4)).toBe('abcd…')
  })
})

describe('buildTitlePrompt', () => {
  it('embeds the purpose text verbatim into the prompt', () => {
    const prompt = buildTitlePrompt('READMEにセットアップ手順を追記して')
    expect(prompt).toContain('READMEにセットアップ手順を追記して')
    expect(prompt).toContain('20字程度')
  })
})

describe('sanitizeGeneratedTitle', () => {
  it('takes the first non-blank line', () => {
    expect(sanitizeGeneratedTitle('\n\nREADME整備\n\nこれはおまけ行')).toBe('README整備')
  })

  it('collapses and clips an overlong single-line response', () => {
    const raw = 'a'.repeat(TITLE_MAX_LENGTH + 5)
    expect(sanitizeGeneratedTitle(raw)).toBe('a'.repeat(TITLE_MAX_LENGTH) + '…')
  })

  it('returns null when the output has no usable content', () => {
    expect(sanitizeGeneratedTitle('   \n  \n ')).toBeNull()
    expect(sanitizeGeneratedTitle('')).toBeNull()
  })
})
