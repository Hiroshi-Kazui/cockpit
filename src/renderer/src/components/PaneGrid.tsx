// Renders all 4 panes always-mounted; layout mode only toggles CSS visibility/placement so that
// a running pty's terminal state is not torn down by a layout switch. Draggable dividers ("しきい")
// resize the grid tracks by adjusting the column/row fractions -- purely a grid-template change, so
// resizing (like a layout switch) never remounts a Pane or disturbs its pty.
import { useRef } from 'react'
import { PANE_INDICES, type PaneIndex, type PaneSetting, type PurposeSummary } from '@shared/ipc'
import { clampGridFraction, type LayoutMode } from '@shared/layout'
import { Pane } from './Pane'

type ResizeAxis = 'column' | 'row'

interface PaneGridProps {
  layout: LayoutMode
  paneSettings: readonly PaneSetting[]
  visiblePanes: ReadonlySet<PaneIndex>
  onCwdChange: (pane: PaneIndex, cwd: string) => void
  claudeResolved: boolean
  purposesByPane: Readonly<Record<PaneIndex, PurposeSummary | null>>
  onRegisterFocus: (pane: PaneIndex, focusFn: (() => void) | null) => void
  /** M9 FIX: forwarded straight through to each Pane -- see Pane.tsx's prop doc comment. */
  onEvaluationDialogVisibilityChange: (pane: PaneIndex, visible: boolean) => void
  columnFraction: number
  rowFraction: number
  onResize: (axis: ResizeAxis, fraction: number) => void
  onResizeCommit: () => void
}

export function PaneGrid({
  layout,
  paneSettings,
  visiblePanes,
  onCwdChange,
  claudeResolved,
  purposesByPane,
  onRegisterFocus,
  onEvaluationDialogVisibilityChange,
  columnFraction,
  rowFraction,
  onResize,
  onResizeCommit
}: PaneGridProps): React.JSX.Element {
  const gridRef = useRef<HTMLDivElement>(null)

  const gridTemplateColumns =
    layout === 'single' ? '1fr' : `${columnFraction}fr ${1 - columnFraction}fr`
  const gridTemplateRows = layout === 'split4' ? `${rowFraction}fr ${1 - rowFraction}fr` : '1fr'

  const hasVerticalDivider = layout === 'split2' || layout === 'split4'
  const hasHorizontalDivider = layout === 'split4'

  function startDrag(axis: ResizeAxis): (event: React.PointerEvent) => void {
    return (event) => {
      event.preventDefault()
      const onMove = (ev: PointerEvent): void => {
        const grid = gridRef.current
        if (!grid) return
        const rect = grid.getBoundingClientRect()
        const raw =
          axis === 'column'
            ? (ev.clientX - rect.left) / rect.width
            : (ev.clientY - rect.top) / rect.height
        onResize(axis, clampGridFraction(raw))
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.classList.remove('is-pane-resizing')
        onResizeCommit()
      }
      document.body.classList.add('is-pane-resizing')
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }
  }

  return (
    <div
      ref={gridRef}
      className={`pane-grid pane-grid--${layout}`}
      style={{ gridTemplateColumns, gridTemplateRows }}
    >
      {PANE_INDICES.map((pane) => (
        <div
          key={pane}
          className="pane-slot"
          style={{ display: visiblePanes.has(pane) ? undefined : 'none' }}
        >
          <Pane
            paneIndex={pane}
            defaultCwd={paneSettings.find((s) => s.pane === pane)?.defaultCwd ?? null}
            onCwdChange={onCwdChange}
            claudeResolved={claudeResolved}
            purpose={purposesByPane[pane]}
            onRegisterFocus={onRegisterFocus}
            onEvaluationDialogVisibilityChange={onEvaluationDialogVisibilityChange}
          />
        </div>
      ))}
      {hasVerticalDivider && (
        <div
          className="pane-divider pane-divider--vertical"
          role="separator"
          aria-orientation="vertical"
          aria-label="左右ペインの境界をドラッグで調整"
          style={{ left: `${columnFraction * 100}%` }}
          onPointerDown={startDrag('column')}
        />
      )}
      {hasHorizontalDivider && (
        <div
          className="pane-divider pane-divider--horizontal"
          role="separator"
          aria-orientation="horizontal"
          aria-label="上下ペインの境界をドラッグで調整"
          style={{ top: `${rowFraction * 100}%` }}
          onPointerDown={startDrag('row')}
        />
      )}
    </div>
  )
}
