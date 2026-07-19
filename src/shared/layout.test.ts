// Behavioral tests for layout -> visible pane mapping (spec §4.1: 1 / 2分割 / 4分割, max 4 panes).
import { describe, expect, it } from 'vitest'
import { isLayoutMode, paneCountForLayout, visiblePanesForLayout } from './layout'

describe('paneCountForLayout', () => {
  it('single layout shows exactly 1 pane', () => {
    expect(paneCountForLayout('single')).toBe(1)
  })

  it('split2 layout shows exactly 2 panes', () => {
    expect(paneCountForLayout('split2')).toBe(2)
  })

  it('split4 layout shows exactly 4 panes (max)', () => {
    expect(paneCountForLayout('split4')).toBe(4)
  })
})

describe('visiblePanesForLayout', () => {
  it('single -> [0]', () => {
    expect(visiblePanesForLayout('single')).toEqual([0])
  })

  it('split2 -> [0, 1]', () => {
    expect(visiblePanesForLayout('split2')).toEqual([0, 1])
  })

  it('split4 -> [0, 1, 2, 3]', () => {
    expect(visiblePanesForLayout('split4')).toEqual([0, 1, 2, 3])
  })
})

describe('isLayoutMode', () => {
  it('accepts known layout modes', () => {
    expect(isLayoutMode('single')).toBe(true)
    expect(isLayoutMode('split2')).toBe(true)
    expect(isLayoutMode('split4')).toBe(true)
  })

  it('rejects unknown strings', () => {
    expect(isLayoutMode('triple')).toBe(false)
    expect(isLayoutMode('')).toBe(false)
  })
})
