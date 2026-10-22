import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (preview, heading = 'Demo product', brokenExpandable = false) => {
  const toggle = brokenExpandable ? 'void(0)' : "this.setAttribute('aria-expanded',this.getAttribute('aria-expanded')==='true'?'false':'true')";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Runner demo</title><style>body{margin:0;color:#173c32;font:16px Georgia,serif;background:${preview ? '#e4edce' : '#fff'}}main{min-height:80vh;display:grid;place-content:center;text-align:center;padding:30px}h1{font-size:48px}button{padding:12px 18px;background:#174c39;color:white;border:0;cursor:pointer}</style></head><body><main><h1>${heading}</h1><button onclick="document.querySelector('#state').textContent='Demo item added'">Add to cart</button><button type="button" aria-expanded="false" onclick="${toggle}">Toggle details</button><p id="state" aria-live="polite"></p></main></body></html>`;
};

function runRunner(inputPath, { cancelOnRequest } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'qa', 'runner.mjs'), inputPath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    let cancelTimer;
    cancelOnRequest?.then(() => { cancelTimer = setTimeout(() => child.kill('SIGTERM'), 50); });
    child.on('error', reject);
    child.on('close', (status, signal) => { clearTimeout(timer); clearTimeout(cancelTimer); resolve({ status, signal, stdout, stderr }); });
  });
}

test('runner creates pixel diff evidence and reports an explicit task failure', { timeout: 120_000 }, async () => {
  let resolveHangRequest;
  const hangRequested = new Promise((resolve) => { resolveHangRequest = resolve; });
  const server = http.createServer((request, response) => {
    if (request.url === '/hang') { resolveHangRequest(); return; }
    if (request.url === '/broken-reference') {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Reference temporarily unavailable');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixture(request.url === '/changed', request.url === '/content-reference' ? 'Older product copy' : 'Demo product', request.url === '/broken-controls'));
  });
  let temporary;
  try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gleefull-qa-'));
  const runId = `integration-${Date.now()}`;
  const runDir = path.join(temporary, 'runs', runId);
  await fs.mkdir(path.join(runDir, 'artifacts'), { recursive: true });
  const page = { id: 'fixture-page', name: 'Fixture product', enabled: true, liveUrl: `${base}/reference`, previewUrl: `${base}/changed`, productionUrl: `${base}/reference`, expectedTitle: 'Runner demo', expectedHeading: 'Demo product', ignoreSelectors: [] };
  const input = { runId, environment: 'preview', mode: 'full', pages: [page], task: null, viewports: ['desktop'], accessibility: true, config: { visualThreshold: 0.1 }, startedAt: new Date().toISOString() };
  await fs.writeFile(path.join(runDir, 'input.json'), JSON.stringify(input));
  const result = await runRunner(path.join(runDir, 'input.json'));
  assert.equal(result.signal, null, result.stderr || result.stdout);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(await fs.readFile(path.join(runDir, 'report.json'), 'utf8'));
  assert.ok(report.summary.visualDifferences >= 1, 'expected the intentional fixture style change to be detected');
  assert.ok(report.pages[0].screenshots.desktop.live);
  assert.ok(report.pages[0].screenshots.desktop.target);
  assert.ok(report.pages[0].visual[0].diff);
  assert.ok(report.checks.some((check) => check.category === 'accessibility' && check.title.includes('axe scan')));
  await fs.access(path.join(runDir, 'report.html'));
  await fs.access(path.join(runDir, 'artifacts', path.basename(report.pages[0].visual[0].diff)));

  const productionRunId = `${runId}-production`;
  const productionDir = path.join(temporary, 'runs', productionRunId);
  await fs.mkdir(path.join(productionDir, 'artifacts'), { recursive: true });
  await fs.writeFile(path.join(productionDir, 'input.json'), JSON.stringify({ ...input, runId: productionRunId, environment: 'production', mode: 'ui', pages: [{ ...page, productionUrl: `${base}/production` }], accessibility: false }));
  const productionResult = await runRunner(path.join(productionDir, 'input.json'));
  assert.equal(productionResult.status, 0, productionResult.stderr || productionResult.stdout);
  const productionReport = JSON.parse(await fs.readFile(path.join(productionDir, 'report.json'), 'utf8'));
  assert.equal(productionReport.environment, 'production');
  assert.equal(productionReport.pages[0].urls.target, `${base}/production`);
  assert.ok(productionReport.pages[0].screenshots.desktop.live);
  assert.ok(productionReport.pages[0].screenshots.desktop.target);
  assert.equal(productionReport.pages[0].visual[0].comparison, 'live-reference');

  const referenceRunId = `${runId}-reference-error`;
  const referenceDir = path.join(temporary, 'runs', referenceRunId);
  await fs.mkdir(path.join(referenceDir, 'artifacts'), { recursive: true });
  const referencePage = { ...page, liveUrl: `${base}/broken-reference` };
  await fs.writeFile(path.join(referenceDir, 'input.json'), JSON.stringify({ ...input, runId: referenceRunId, mode: 'ui', pages: [referencePage], accessibility: false }));
  const referenceResult = await runRunner(path.join(referenceDir, 'input.json'));
  assert.equal(referenceResult.status, 0, referenceResult.stderr || referenceResult.stdout);
  const referenceReport = JSON.parse(await fs.readFile(path.join(referenceDir, 'report.json'), 'utf8'));
  const referenceIssue = referenceReport.pages[0].issues.find((issue) => issue.title.includes('comparison unavailable'));
  assert.ok(referenceIssue, 'unavailable reference should create a visible issue');
  assert.match(referenceIssue.actual, /HTTP 503/);
  assert.equal(referenceIssue.evidence.length, 2);

  const cancelRunId = `${runId}-cancel`;
  const cancelDir = path.join(temporary, 'runs', cancelRunId);
  await fs.mkdir(path.join(cancelDir, 'artifacts'), { recursive: true });
  const cancelPage = { ...page, previewUrl: `${base}/hang` };
  await fs.writeFile(path.join(cancelDir, 'input.json'), JSON.stringify({ ...input, runId: cancelRunId, mode: 'functional', pages: [cancelPage], accessibility: false }));
  const cancelStarted = Date.now();
  const cancelResult = await runRunner(path.join(cancelDir, 'input.json'), { cancelOnRequest: hangRequested });
  assert.equal(cancelResult.signal, null, cancelResult.stderr || cancelResult.stdout);
  assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
  const cancelStatus = JSON.parse(await fs.readFile(path.join(cancelDir, 'status.json'), 'utf8'));
  assert.equal(cancelStatus.status, 'cancelled');
  const cancelReport = JSON.parse(await fs.readFile(path.join(cancelDir, 'report.json'), 'utf8'));
  assert.equal(cancelReport.status, 'cancelled');
  assert.ok(Date.now() - cancelStarted < 12_000, 'cancel should interrupt navigation instead of waiting for its full timeout');

  const contentRunId = `${runId}-content`;
  const contentDir = path.join(temporary, 'runs', contentRunId);
  await fs.mkdir(path.join(contentDir, 'artifacts'), { recursive: true });
  const contentPage = { ...page, liveUrl: `${base}/content-reference` };
  await fs.writeFile(path.join(contentDir, 'input.json'), JSON.stringify({ ...input, runId: contentRunId, mode: 'ui', pages: [contentPage], accessibility: false }));
  const contentResult = await runRunner(path.join(contentDir, 'input.json'));
  assert.equal(contentResult.status, 0, contentResult.stderr || contentResult.stdout);
  const contentReport = JSON.parse(await fs.readFile(path.join(contentDir, 'report.json'), 'utf8'));
  const contentIssue = contentReport.pages[0].issues.find((issue) => issue.title.includes('title or heading differs'));
  assert.ok(contentIssue, 'Live/target content difference should create an issue');
  assert.match(contentIssue.actual, /Older product copy/);
  assert.equal(contentIssue.category, 'functional');

  const controlRunId = `${runId}-control`;
  const controlDir = path.join(temporary, 'runs', controlRunId);
  await fs.mkdir(path.join(controlDir, 'artifacts'), { recursive: true });
  const controlPage = { ...page, previewUrl: `${base}/broken-controls` };
  await fs.writeFile(path.join(controlDir, 'input.json'), JSON.stringify({ ...input, runId: controlRunId, mode: 'functional', pages: [controlPage], accessibility: false }));
  const controlResult = await runRunner(path.join(controlDir, 'input.json'));
  assert.equal(controlResult.status, 0, controlResult.stderr || controlResult.stdout);
  const controlReport = JSON.parse(await fs.readFile(path.join(controlDir, 'report.json'), 'utf8'));
  assert.ok(controlReport.pages[0].issues.some((issue) => issue.title === 'Expandable button interaction failed'));

  const taskRunId = `${runId}-task`;
  const taskDir = path.join(temporary, 'runs', taskRunId);
  await fs.mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  const task = { id: 'controlled-failure', name: 'Expected confirmation is missing', pageId: page.id, expectedResult: 'Added to cart appears', approved: true, steps: [{ action: 'clickRole', value: 'button', name: 'Add to cart' }, { action: 'expectText', value: 'Added to cart' }] };
  await fs.writeFile(path.join(taskDir, 'input.json'), JSON.stringify({ ...input, runId: taskRunId, mode: 'task', task }));
  const taskResult = await runRunner(path.join(taskDir, 'input.json'));
  assert.equal(taskResult.signal, null, taskResult.stderr || taskResult.stdout);
  assert.equal(taskResult.status, 0, taskResult.stderr || taskResult.stdout);
  const taskReport = JSON.parse(await fs.readFile(path.join(taskDir, 'report.json'), 'utf8'));
  assert.equal(taskReport.summary.functionalFailures, 1);
  assert.equal(taskReport.pages[0].issues[0].category, 'task-specific');
  assert.match(taskReport.pages[0].issues[0].actual, /Timeout|waiting/i);

  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  }
});
