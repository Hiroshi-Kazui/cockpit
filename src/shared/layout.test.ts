// Behavioral tests for layout -> visible pane mapping (spec §4.1: 1 / 2分割 / 4分割, max 4 panes).
import { describe, expect, it } from 'vitest'
import {
  clampGridFraction,
  GRID_FRACTION_DEFAULT,
  GRID_FRACTION_MAX,
  GRID_FRACTION_MIN,
  isLayoutMode,
  paneCountForLayout,
  visiblePanesForLayout
} from './layout'

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

describe('clampGridFraction (draggable pane-divider bounds)', () => {
  it('passes through a value already within range', () => {
    expect(clampGridFraction(0.5)).toBe(0.5)
    expect(clampGridFraction(0.3)).toBe(0.3)
  })

  it('clamps below the minimum (a pane can never be dragged to zero)', () => {
    expect(clampGridFraction(0)).toBe(GRID_FRACTION_MIN)
    expect(clampGridFraction(-1)).toBe(GRID_FRACTION_MIN)
  })

  it('clamps above the maximum', () => {
    expect(clampGridFraction(1)).toBe(GRID_FRACTION_MAX)
    expect(clampGridFraction(2)).toBe(GRID_FRACTION_MAX)
  })

  it('falls back to the even-split default for non-finite input', () => {
    expect(clampGridFraction(Number.NaN)).toBe(GRID_FRACTION_DEFAULT)
    expect(clampGridFraction(Number.POSITIVE_INFINITY)).toBe(GRID_FRACTION_DEFAULT)
  })
})
