import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Unit test config for shared/ and main/ pure logic (node environment; no Electron runtime needed).
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
