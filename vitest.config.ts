import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': resolve(__dirname, 'test/stubs/cloudflare-workers.ts'),
    },
  },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
})
