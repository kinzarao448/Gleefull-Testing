import { test, expect } from '@playwright/test';

const resetPairs = (request) => request.put('/api/pairs', { data: { pairs: [] } });

test('saves Preview/Live URL pairs, supports 10+ rows, and deletes individual rows', async ({ page, request }) => {
  await resetPairs(request);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Daily regression' })).toBeVisible();
  await expect(page.locator('#pairsBody tr')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Run Regression Tests' })).toBeVisible();
  await expect(page.locator('#taskDialog, #tasks, #environment, #authorized, [id*="Figma" i]')).toHaveCount(0);

  await page.getByLabel('Preview Link (DEV), page 1').fill('https://preview.example.test/home');
  await page.getByLabel('Live Link (PROD), page 1').fill('https://live.example.test/home');
  for (let index = 0; index < 11; index++) await page.getByRole('button', { name: '+ Add Page' }).click();
  await expect(page.locator('#pairsBody [data-field="previewUrl"]')).toHaveCount(12);
  await page.getByLabel('Preview Link (DEV), page 12').fill('https://preview.example.test/page-12');
  await page.getByLabel('Live Link (PROD), page 12').fill('https://live.example.test/page-12');

  await expect.poll(async () => request.get('/api/pairs').then((response) => response.json().then((saved) => saved.length))).toBe(12);
  await page.reload();
  await expect(page.getByLabel('Preview Link (DEV), page 1', { exact: true })).toHaveValue('https://preview.example.test/home');
  await expect(page.locator('#pairsBody [data-field="previewUrl"]')).toHaveCount(12);
  await page.getByRole('button', { name: 'Delete page 12' }).click();
  await expect(page.locator('#pairsBody [data-field="previewUrl"]')).toHaveCount(11);
  await expect.poll(async () => request.get('/api/pairs').then((response) => response.json().then((saved) => saved.length))).toBe(11);
});

test('requires both valid URLs before allowing the regression run', async ({ page, request }) => {
  await resetPairs(request);
  await page.goto('/');
  await page.getByRole('button', { name: 'Run Regression Tests' }).click();
  await expect(page.locator('#pairsBody input:invalid')).toHaveCount(2);
  await expect(page.locator('#progress')).toBeHidden();

  await page.getByLabel('Preview Link (DEV), page 1').fill('not-a-url');
  await page.getByLabel('Live Link (PROD), page 1').fill('https://live.example.test/');
  await page.getByRole('button', { name: 'Run Regression Tests' }).click();
  await expect(page.locator('#pairsBody input:invalid')).toHaveCount(1);
  await expect(page.locator('#progress')).toBeHidden();
});

test('simple URL pair table fits a mobile viewport', async ({ page, request }) => {
  await resetPairs(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
  await expect(page.getByRole('button', { name: 'Run Regression Tests' })).toBeVisible();
});

test('runs both regressions for each saved pair and reports where issues occur', { timeout: 60_000 }, async ({ page, request }) => {
  const origin = 'http://127.0.0.1:4174';
  await request.put('/api/pairs', { data: { pairs: [{ id: 'local-demo', previewUrl: `${origin}/demo/changed`, liveUrl: `${origin}/demo/reference` }] } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Run Regression Tests' }).click();

  await expect(page.locator('.page-result')).toHaveCount(1, { timeout: 35_000 });
  await expect(page.locator('.issue h4').filter({ hasText: 'visual regression' }).first()).toBeVisible();
  await expect(page.locator('.screenshot-pair')).toHaveCount(2);
  await expect(page.locator('.page-result').first()).toContainText('Page 1');
  await expect(page.locator('.issue').first()).toContainText('/demo/changed');
  await expect(page.getByRole('link', { name: 'Open detailed report' })).toBeVisible();

  const report = await request.get('/api/runs').then((response) => response.json());
  const detail = await request.get(`/api/runs/${report[0].runId}`).then((response) => response.json());
  expect(detail.summary.visualDifferences).toBeGreaterThan(0);
  expect(detail.checks.some((check) => check.title.includes('DOM ready time'))).toBe(true);
  expect(detail.checks.some((check) => check.title.includes('Forms expose safe required-field validation'))).toBe(true);
  expect(detail.checks.some((check) => check.title.includes('Links and buttons are named'))).toBe(true);
  expect(detail.checks.some((check) => check.title.includes('Safe expandable button interactions'))).toBe(true);
});
