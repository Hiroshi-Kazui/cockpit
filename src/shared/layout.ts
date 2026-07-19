// Pure layout logic: maps a layout mode to the set of visible pane indices (spec §4.1).
import type { PaneIndex } from './ipc'

export type LayoutMode = 'single' | 'split2' | 'split4'

export const LAYOUT_MODES: readonly LayoutMode[] = ['single', 'split2', 'split4']

export function paneCountForLayout(mode: LayoutMode): number {
  switch (mode) {
    case 'single':
      return 1
    case 'split2':
      return 2
    case 'split4':
      return 4
  }
}

/** Returns the pane indices that should be rendered/active for a given layout mode, in order. */
export function visiblePanesForLayout(mode: LayoutMode): PaneIndex[] {
  const count = paneCountForLayout(mode)
  const all: PaneIndex[] = [0, 1, 2, 3]
  return all.slice(0, count)
}

export function isLayoutMode(value: string): value is LayoutMode {
  return (LAYOUT_MODES as readonly string[]).includes(value)
}
