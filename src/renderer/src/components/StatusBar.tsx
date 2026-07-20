// App-wide status bar (spec §4.5): 5時間/週次の残量ゲージ + reset time. Shows Anthropic-server-measured
// rate_limits when available; falls back to a local-estimate display (with a "推定" badge) when
// rate_limits is empty (e.g. APIキーログイン), using the plan-limit preset configured here (spec's
// "設定画面のプラン上限...手動調整可"). Purely presentational -- all percentages/colors/estimates are
// already computed in main (shared/usage.ts's pure functions via usageCoordinator.ts).
//
// M3 FIX iteration 2 (minor #5): the gauge fill color now danger-codes remaining quota (via
// remainingPercentageColor) rather than double-encoding the measured/estimated distinction, which is
// already carried by the "推定" badge below.
import { useState, type Ref } from 'react'
import type {
  MirrorStatusSummary,
  PlanPreset,
  RateLimitWindowDisplay,
  UsageDisplay,
  UsageSettings
} from '@shared/ipc'
import { isEstimatedDisplay, remainingPercentageColor } from '@shared/usage'

const PRESET_LABELS: Record<PlanPreset, string> = {
  pro: 'Pro',
  max5x: 'Max 5x',
  max20x: 'Max 20x',
  custom: 'カスタム'
}

function formatResetLabel(resetsAtMs: number | null): string | null {
  if (resetsAtMs === null) return null
  const remainingMs = Math.max(0, resetsAtMs - Date.now())
  const totalMinutes = Math.floor(remainingMs / 60_000)
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `↻ ${days}日${hours}時間後`
  if (hours > 0) return `↻ ${hours}時間${minutes}分後`
  return `↻ ${minutes}分後`
}

function Gauge({ label, w }: { label: string; w: RateLimitWindowDisplay }): React.JSX.Element {
  const remaining = Math.round(w.remainingPercentage)
  const resetLabel = formatResetLabel(w.resetsAtMs)
  const color = remainingPercentageColor(w.remainingPercentage)
  return (
    <div className="status-gauge">
      <span className="status-gauge__label">{label}</span>
      <div className="status-gauge__bar">
        <div
          className={`status-gauge__fill status-gauge__fill--${color}`}
          style={{ width: `${remaining}%` }}
        />
      </div>
      <span className="status-gauge__value">残り {remaining}%</span>
      {resetLabel && <span className="status-gauge__reset">{resetLabel}</span>}
    </div>
  )
}

interface StatusBarProps {
  display: UsageDisplay | null
  settings: UsageSettings | null
  settingsError: string | null
  onSettingsChange: (next: UsageSettings) => void
  /** M6 (spec §4.4.1): archive-output mirror status, or null while not yet loaded. `outputRoot: null`
   * means mirroring is unconfigured -- the indicator below renders nothing in that case (there is nothing
   * to report). */
  mirrorStatus: MirrorStatusSummary | null
  onOpenArchiveOutputSettings: () => void
  /** M7 followup: forwarded down to the mirror indicator button so App.tsx can restore focus to it
   * specifically when the settings dialog was opened from here (see MirrorIndicator's buttonRef doc). */
  mirrorIndicatorButtonRef: Ref<HTMLButtonElement>
}

// M6 usability note (plan.md Phase 3): mirror errors are surfaced here, non-modally, specifically so they
// never block or interrupt the claude dialogue in any pane -- clicking through opens the detail dialog,
// but the indicator itself never demands attention the way a modal would.
function MirrorIndicator({
  mirrorStatus,
  onOpen,
  buttonRef
}: {
  mirrorStatus: MirrorStatusSummary | null
  onOpen: () => void
  /** M7 followup (UX: フォーカス復帰先の不一致) -- App.tsx focuses this element back when the dialog it
   * opens is closed via this indicator (rather than always returning focus to the header button,
   * regardless of which of the two actually opened it). */
  buttonRef: Ref<HTMLButtonElement>
}): React.JSX.Element | null {
  if (!mirrorStatus || mirrorStatus.outputRoot === null) return null
  const errorCount = mirrorStatus.entries.filter((e) => e.state === 'error').length
  const pendingCount = mirrorStatus.entries.filter((e) => e.state === 'pending').length
  const variant = errorCount > 0 ? 'error' : pendingCount > 0 ? 'pending' : 'synced'
  const label =
    errorCount > 0
      ? `ミラー: エラー ${errorCount}件`
      : pendingCount > 0
        ? `ミラー: 保留 ${pendingCount}件`
        : 'ミラー: 同期済み'
  return (
    <button
      type="button"
      ref={buttonRef}
      className={`status-bar__mirror status-bar__mirror--${variant}`}
      onClick={onOpen}
      title={
        errorCount > 0
          ? 'アーカイブのミラー同期でエラーが発生しています（claude との対話は継続できます）'
          : 'アーカイブ出力先の同期状態'
      }
    >
      {label}
    </button>
  )
}

export function StatusBar({
  display,
  settings,
  settingsError,
  onSettingsChange,
  mirrorStatus,
  onOpenArchiveOutputSettings,
  mirrorIndicatorButtonRef
}: StatusBarProps): React.JSX.Element {
  const estimated = display ? isEstimatedDisplay(display) : false
  // M3 FIX iteration 2 (minor #7): a custom-limit input that fails validation was previously silently
  // dropped (no feedback), leaving the user unsure why their edit didn't take. Track a per-field message
  // so an invalid value is explained instead of just discarded.
  const [customLimitErrors, setCustomLimitErrors] = useState<{
    customFiveHourTokens: string | null
    customWeeklyTokens: string | null
  }>({ customFiveHourTokens: null, customWeeklyTokens: null })

  function handlePresetChange(preset: PlanPreset): void {
    if (!settings) return
    onSettingsChange({ ...settings, preset })
  }

  function handleCustomLimitChange(
    field: 'customFiveHourTokens' | 'customWeeklyTokens',
    raw: string
  ): void {
    if (!settings) return
    const trimmed = raw.trim()
    if (trimmed.length === 0) {
      setCustomLimitErrors((prev) => ({ ...prev, [field]: null }))
      onSettingsChange({ ...settings, [field]: null })
      return
    }
    const value = Number(trimmed)
    if (Number.isFinite(value) && value > 0) {
      setCustomLimitErrors((prev) => ({ ...prev, [field]: null }))
      onSettingsChange({ ...settings, [field]: value })
      return
    }
    setCustomLimitErrors((prev) => ({ ...prev, [field]: '0より大きい数値を入力してください' }))
  }

  return (
    <div className="status-bar">
      {estimated && (
        <span
          className="status-bar__badge"
          title="rate_limits が未提供のため、ローカル集計とプラン上限からの推定値を表示しています"
        >
          推定
        </span>
      )}
      {display ? (
        <>
          <Gauge label="5時間" w={display.fiveHour} />
          <Gauge label="週次" w={display.weekly} />
        </>
      ) : (
        <span className="status-bar__waiting">使用量データ待機中…</span>
      )}
      <div className="status-bar__plan">
        <label htmlFor="plan-preset">プラン</label>
        <select
          id="plan-preset"
          value={settings?.preset ?? 'pro'}
          onChange={(e) => handlePresetChange(e.target.value as PlanPreset)}
        >
          {(Object.keys(PRESET_LABELS) as PlanPreset[]).map((preset) => (
            <option key={preset} value={preset}>
              {PRESET_LABELS[preset]}
            </option>
          ))}
        </select>
        {settings?.preset === 'custom' && (
          <>
            <input
              type="number"
              aria-label="5時間あたりのトークン上限"
              placeholder="5hトークン上限"
              defaultValue={settings.customFiveHourTokens ?? ''}
              onBlur={(e) => handleCustomLimitChange('customFiveHourTokens', e.target.value)}
            />
            {customLimitErrors.customFiveHourTokens && (
              <span className="status-bar__field-error" role="alert">
                {customLimitErrors.customFiveHourTokens}
              </span>
            )}
            <input
              type="number"
              aria-label="週次トークン上限"
              placeholder="週次トークン上限"
              defaultValue={settings.customWeeklyTokens ?? ''}
              onBlur={(e) => handleCustomLimitChange('customWeeklyTokens', e.target.value)}
            />
            {customLimitErrors.customWeeklyTokens && (
              <span className="status-bar__field-error" role="alert">
                {customLimitErrors.customWeeklyTokens}
              </span>
            )}
          </>
        )}
      </div>
      {settingsError && (
        <span className="status-bar__error" role="alert">
          設定の保存に失敗しました: {settingsError}
        </span>
      )}
      <MirrorIndicator
        mirrorStatus={mirrorStatus}
        onOpen={onOpenArchiveOutputSettings}
        buttonRef={mirrorIndicatorButtonRef}
      />
    </div>
  )
}
