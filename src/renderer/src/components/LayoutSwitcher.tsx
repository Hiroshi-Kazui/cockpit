// UI control to switch between the 1 / 2-split / 4-split pane layouts (spec §4.1, AC #2).
import { LAYOUT_MODES, type LayoutMode } from '@shared/layout'

interface LayoutSwitcherProps {
  value: LayoutMode
  onChange: (mode: LayoutMode) => void
}

const LABELS: Record<LayoutMode, string> = {
  single: '1',
  split2: '2分割',
  split4: '4分割'
}

export function LayoutSwitcher({ value, onChange }: LayoutSwitcherProps): React.JSX.Element {
  return (
    <div className="layout-switcher" role="group" aria-label="レイアウト切替">
      {LAYOUT_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          className={mode === value ? 'layout-switcher__button active' : 'layout-switcher__button'}
          aria-pressed={mode === value}
          onClick={() => onChange(mode)}
        >
          {LABELS[mode]}
        </button>
      ))}
    </div>
  )
}
