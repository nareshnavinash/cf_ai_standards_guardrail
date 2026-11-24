/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test'
import { E2E_EVAL_KEY } from '../playwright.config'

const sample = (page: Page, name: string) => page.getByRole('button', { name, exact: true })

async function runSample(page: Page, name = 'leaky-config') {
  await sample(page, name).click()
  await expect(page.locator('#findings .finding').first()).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#samples .chip')).toHaveCount(4)
})

test('samples list renders', async ({ page }) => {
  await expect(page.locator('#samples .chip')).toHaveText(['leaky-config', 'swallowed-errors', 'untested-endpoint', 'clean-change'])
  await expect(page.locator('#status')).toContainText('Pick a sample')
})

test('leaky-config shows STD-001 findings and the static-only banner', async ({ page }) => {
  await runSample(page)
  await expect(page.locator('#findings .finding .badge', { hasText: 'STD-001' }).first()).toBeVisible()
  expect(await page.locator('#findings .finding .badge', { hasText: 'STD-001' }).count()).toBeGreaterThanOrEqual(2)
  await expect(page.locator('#banners')).toContainText('static-only')
})

test('an exception suppresses the finding after a re-run', async ({ page }) => {
  await runSample(page)
  await page.getByRole('button', { name: 'Add exception…' }).first().click()
  const form = page.locator('.exc-form')
  await expect(form.getByLabel('Rule')).toHaveValue('STD-001')
  await expect(form.getByLabel('Path glob')).toHaveValue('src/**')
  await form.getByLabel('Reason').fill('Demo credentials in a sample config')
  await form.getByRole('button', { name: 'Save exception' }).click()
  await expect(page.locator('#exceptions')).toContainText('STD-001')
  await expect(page.locator('#status')).toContainText('Exception saved')
  await page.getByRole('button', { name: 'Re-run review' }).click()
  await expect(page.locator('#suppressed-title')).toContainText('Suppressed by exceptions (2)')
  await expect(page.locator('#findings .finding .badge', { hasText: 'STD-001' })).toHaveCount(0)
})

test('a catch-all glob is rejected inline', async ({ page }) => {
  await runSample(page)
  await page.getByRole('button', { name: 'Add exception…' }).first().click()
  const form = page.locator('.exc-form')
  await form.getByLabel('Path glob').fill('**')
  await form.getByLabel('Reason').fill('Everything is fine')
  await form.getByRole('button', { name: 'Save exception' }).click()
  await expect(form.locator('.error')).toBeVisible()
  await expect(form.locator('.error')).toContainText(/glob|broad|match/i)
  await expect(page.locator('#exceptions')).toContainText('None yet.')
})

test('an issue URL is rejected inline', async ({ page }) => {
  await page.getByLabel('or paste a public GitHub PR URL').fill('https://github.com/a/b/issues/1')
  await page.getByRole('button', { name: 'Review', exact: true }).click()
  await expect(page.locator('#form-error')).toBeVisible()
  await expect(page.locator('#form-error')).toContainText('Paste a link like')
})

test('an XSS payload from a diff renders as text', async ({ page, request }) => {
  const payload = '<img src=x onerror=alert(1)>'
  const diff = [
    `diff --git a/src/${payload}.ts b/src/${payload}.ts`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/src/${payload}.ts`,
    '@@ -0,0 +1,1 @@',
    `+export const m = "${payload}" // TODO <script>alert(2)</script>`,
    '',
  ].join('\n')
  const created = await request.post('/api/reviews', {
    headers: { 'x-eval-key': E2E_EVAL_KEY },
    data: { evalDiff: diff, repo: 'eval/xss', evalMode: 'static-only' },
  })
  expect(created.status()).toBe(202)
  const { reviewId } = (await created.json()) as { reviewId: string }

  const dialogs: string[] = []
  page.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.dismiss()
  })
  // Make the UI poll the eval-created review instead of creating its own.
  await page.route('**/api/reviews', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ reviewId, repo: 'eval/xss', mode: 'static-only' }) })
      : route.continue(),
  )
  await sample(page, 'clean-change').click()
  await expect(page.locator('#findings .finding').first()).toBeVisible()
  await expect(page.locator('#findings')).toContainText(payload)
  await page.waitForTimeout(500)
  expect(dialogs).toEqual([])
  await expect(page.locator('img')).toHaveCount(0)
  await expect(page.locator('#findings img, #findings script')).toHaveCount(0)
})

test('works with localStorage and sessionStorage blocked', async ({ browser }) => {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(window, name, {
        get() {
          throw new DOMException('blocked', 'SecurityError')
        },
      })
    }
  })
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.locator('#visitor-notice')).toBeVisible()
  await expect(page.locator('#visitor-notice')).toContainText('Exceptions last only for this tab')
  await runSample(page)
  await page.getByRole('button', { name: 'Add exception…' }).first().click()
  const form = page.locator('.exc-form')
  await form.getByLabel('Reason').fill('Works without storage')
  await form.getByRole('button', { name: 'Save exception' }).click()
  await expect(page.locator('#exceptions')).toContainText('STD-001')
  await context.close()
})

test('has no horizontal overflow at 375px', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 } })
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.locator('#samples .chip')).toHaveCount(4)
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(await overflow()).toBeLessThanOrEqual(0)
  await runSample(page)
  await page.getByRole('button', { name: 'Add exception…' }).first().click()
  await expect(page.locator('.exc-form')).toBeVisible()
  expect(await overflow()).toBeLessThanOrEqual(0)
  await context.close()
})

test('double-clicking a sample starts one review', async ({ page }) => {
  let posts = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/reviews') posts++
  })
  await sample(page, 'swallowed-errors').dblclick()
  await expect(page.locator('#findings .finding').first()).toBeVisible()
  expect(posts).toBe(1)
})
