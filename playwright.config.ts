// Playwright + Electron E2E config (M5). Deliberately separate from vitest.config.ts (unit tests, node
// environment, `src/**/*.test.ts` only) -- `npm run build` must run first (see package.json's
// `test:e2e` script) so `out/main/index.js` etc. reflect the current source before Electron is launched.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  // Each spec launches its own isolated Electron instance with a fresh --user-data-dir (see
  // e2e/fixtures/electronApp.ts), so parallel workers would be safe; kept sequential (workers: 1) purely
  // because this suite is small and a single worker is far easier to debug when a spec fails.
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure'
  }
})
