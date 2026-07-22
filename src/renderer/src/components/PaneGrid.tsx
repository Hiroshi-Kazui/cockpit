// Renders all 4 panes always-mounted; layout mode only toggles CSS visibility/placement so that
// a running pty's terminal state is not torn down by a layout switch.
import { PANE_INDICES, type PaneIndex, type PaneSetting, type PurposeSummary } from '@shared/ipc'
import type { LayoutMode } from '@shared/layout'
import { Pane } from './Pane'

interface PaneGridProps {
  layout: LayoutMode
  paneSettings: readonly PaneSetting[]
  visiblePanes: ReadonlySet<PaneIndex>
  onCwdChange: (pane: PaneIndex, cwd: string) => void
  claudeResolved: boolean
  purposesByPane: Readonly<Record<PaneIndex, PurposeSummary | null>>
  /** M5: forwarded straight through to each Pane -- see Pane.tsx's prop doc comment. */
  onRegisterFocus: (pane: PaneIndex, focusFn: (() => void) | null) => void
  /** M9 FIX: forwarded straight through to each Pane -- see Pane.tsx's prop doc comment. */
  onEvaluationDialogVisibilityChange: (pane: PaneIndex, visible: boolean) => void
}

export function PaneGrid({
  layout,
  paneSettings,
  visiblePanes,
  onCwdChange,
  claudeResolved,
  purposesByPane,
  onRegisterFocus,
  onEvaluationDialogVisibilityChange
}: PaneGridProps): React.JSX.Element {
  return (
    <div className={`pane-grid pane-grid--${layout}`}>
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
    </div>
  )
}
