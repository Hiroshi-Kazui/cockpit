// Unit tests for the pure SQL LIKE pattern escaper (M5, spec §4.4 "検索").
import { describe, expect, it } from 'vitest'
import { buildContainsLikePattern, escapeLikePattern } from './sqlLike'

describe('escapeLikePattern', () => {
  it('leaves ordinary text untouched', () => {
    expect(escapeLikePattern('READMEにセットアップ手順を追記して')).toBe(
      'READMEにセットアップ手順を追記して'
    )
  })

  it('escapes a literal percent so it is not treated as a wildcard', () => {
    expect(escapeLikePattern('100% done')).toBe('100\\% done')
  })

  it('escapes a literal underscore so it is not treated as a single-char wildcard', () => {
    expect(escapeLikePattern('my_folder')).toBe('my\\_folder')
  })

  it('escapes a literal backslash first (before % and _), so an already-escaped sequence is not double-unescaped', () => {
    expect(escapeLikePattern('C:\\repo')).toBe('C:\\\\repo')
  })

  it('escapes backslash before percent/underscore so escaping order cannot produce a spurious escape sequence', () => {
    // If '%'/'_' were escaped before '\\', the resulting '\\%' would itself get its backslash escaped
    // into '\\\\%' -- wrong. Escaping '\\' first avoids that: input '\\%' -> '\\\\%' (one real backslash,
    // escaped, followed by an escaped percent).
    expect(escapeLikePattern('\\%')).toBe('\\\\\\%')
  })

  it('escapes a mix of all three special characters', () => {
    expect(escapeLikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d')
  })
})

describe('buildContainsLikePattern', () => {
  it('wraps the escaped text in %...% for a contains match', () => {
    expect(buildContainsLikePattern('hello')).toBe('%hello%')
  })

  it('wraps and escapes together', () => {
    expect(buildContainsLikePattern('50%_done')).toBe('%50\\%\\_done%')
  })

  it('produces the empty-search wildcard (matches everything) for an empty string', () => {
    expect(buildContainsLikePattern('')).toBe('%%')
  })
})
