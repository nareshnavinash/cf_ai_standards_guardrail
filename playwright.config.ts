import { defineConfig, devices } from '@playwright/test'

const PORT = 8790
export const E2E_EVAL_KEY = 'e2e-local-eval-key'

/**
 * The Worker runs locally with DAILY_NEURON_BUDGET=0 (see wrangler.e2e.jsonc), so every review is static-only and
 * spends no Workers AI neurons. State lives in a throwaway directory that is wiped on each start.
 */
export default defineConfig({
  testDir: 'tests-e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  webServer: {
    command: `rm -rf .wrangler/e2e-state && npx wrangler dev -c wrangler.e2e.jsonc --ip 127.0.0.1 --port ${PORT} --persist-to .wrangler/e2e-state --var DAILY_NEURON_BUDGET:0 --var EVAL_KEY:${E2E_EVAL_KEY}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
