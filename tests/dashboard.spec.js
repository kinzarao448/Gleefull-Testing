import { test, expect } from '@playwright/test';

test('dashboard saves per-environment page URLs and keeps them after reload', async ({ page, request }) => {
  await request.put('/api/config', { data: { targetEnvironment: 'preview', pages: [], tasks: [], visualThreshold: 0.5, historyRetention: 30 } });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'QA overview' })).toBeVisible();

  await page.getByRole('button', { name: 'Load safe demo' }).click();
  const demoConfig = await request.get('/api/config').then((response) => response.json());
  expect(demoConfig.pages.some((item) => item.id === 'demo-store-page')).toBe(true);
  expect(demoConfig.tasks.some((item) => item.id === 'demo-failing-task')).toBe(true);

  await page.getByRole('button', { name: '+ Add page' }).click();
  await page.getByLabel('Page name').fill('Independent route smoke test');
  await page.getByLabel('Live/reference URL').fill('https://live.example.test/products/red-one');
  await page.getByLabel('Preview URL').fill('https://preview.example.test/catalog/red-one');
  await page.getByLabel('Production URL').fill('https://shop.example.test/p/sku-1');
  await page.getByRole('button', { name: 'Save page' }).click();
  await expect(page.getByRole('row', { name: /Independent route smoke test/ })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('row', { name: /Independent route smoke test/ })).toBeVisible();
  const config = await request.get('/api/config').then((response) => response.json());
  const saved = config.pages.find((item) => item.name === 'Independent route smoke test');
  expect(saved.liveUrl).toContain('/products/red-one');
  expect(saved.previewUrl).toContain('/catalog/red-one');
  expect(saved.productionUrl).toContain('/p/sku-1');
});

test('dashboard keeps the mobile layout within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'QA overview' })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
});

test('empty page selection means all enabled pages', async ({ page, request }) => {
  await request.put('/api/config', { data: { targetEnvironment: 'preview', visualThreshold: 0.5, historyRetention: 30, tasks: [], pages: [{ id: 'home-page', name: 'Home QA page', enabled: true, liveUrl: 'https://live.example.test/', previewUrl: 'https://preview.example.test/', productionUrl: 'https://shop.example.test/' }] } });
  let runRequest;
  await page.route('**/api/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    runRequest = route.request().postDataJSON();
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Captured request for test.' }) });
  });
  await page.goto('/');
  await page.getByRole('checkbox', { name: 'Select Home QA page for test run' }).uncheck();
  await page.getByLabel(/I own or am authorized/).check();
  await page.getByRole('button', { name: 'Start test run' }).click();
  await expect(page.getByRole('status')).toHaveText('Captured request for test.');
  expect(runRequest.pageIds).toEqual(['home-page']);
});

test('editing an approved task requires a new approval', async ({ page, request }) => {
  await request.put('/api/config', { data: { targetEnvironment: 'preview', visualThreshold: 0.5, historyRetention: 30, pages: [{ id: 'page', name: 'Page', previewUrl: 'https://preview.example.test/' }], tasks: [{ id: 'task', name: 'Task', pageId: 'page', expectedResult: 'Old result', steps: [{ action: 'expectText', value: 'Old result' }], approved: true }] } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit steps' }).click();
  await page.getByLabel('Expected result').fill('Changed result');
  await expect(page.getByLabel(/I reviewed these steps/)).not.toBeChecked();
  await page.getByRole('button', { name: 'Save task spec' }).click();
  const config = await request.get('/api/config').then((response) => response.json());
  expect(config.tasks[0].approved).toBe(false);
});

test('dashboard runs an approved local task and displays failure evidence', { timeout: 60_000 }, async ({ page, request }) => {
  await request.put('/api/config', { data: { targetEnvironment: 'preview', pages: [], tasks: [], visualThreshold: 0.5, historyRetention: 30 } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Load safe demo' }).click();
  await page.locator('#mode').selectOption('task');
  await page.locator('#taskPicker').selectOption('demo-failing-task');
  await page.getByLabel(/I own or am authorized/).check();
  await page.getByRole('button', { name: 'Start test run' }).click();
  await expect(page.locator('.issue h3')).toHaveText('Demo: intentionally missing confirmation', { timeout: 20_000 });
  await expect(page.locator('.issue .evidence a')).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'Open local HTML report' })).toBeVisible();
  const history = await request.get('/api/runs').then((response) => response.json());
  const firstRunId = history[0].runId;
  const firstReport = await request.get(`/api/runs/${firstRunId}`).then((response) => response.json());
  const firstIssue = firstReport.pages[0].issues[0];
  expect(firstIssue.firstDetectedRun).toBe(firstRunId);
  await page.locator('.issue [data-issue-status="reviewed"]').click();
  await page.getByRole('button', { name: 'Start test run' }).click();
  await expect(page.locator('.issue h3')).toHaveText('Demo: intentionally missing confirmation', { timeout: 20_000 });
  const secondHistory = await request.get('/api/runs').then((response) => response.json());
  const secondRunId = secondHistory[0].runId;
  const secondReport = await request.get(`/api/runs/${secondRunId}`).then((response) => response.json());
  const repeatedIssue = secondReport.pages[0].issues[0];
  expect(secondRunId).not.toBe(firstRunId);
  expect(repeatedIssue.firstDetectedRun).toBe(firstRunId);
  expect(repeatedIssue.lastDetectedRun).toBe(secondRunId);
  expect(repeatedIssue.status).toBe('reviewed');
  await page.reload();
  await expect(page.locator('#metricVisual')).toHaveText('0');
  await expect(page.locator('#metricFailed')).toHaveText(String(secondReport.summary.failed));
});
