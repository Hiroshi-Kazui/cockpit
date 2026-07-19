// Ambient type declaration exposing the preload-bridged API on `window` for renderer type-checking.
import type { CockpitApi } from './index'

declare global {
  interface Window {
    cockpit: CockpitApi
  }
}

export {}
