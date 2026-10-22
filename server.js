import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { defaultConfig, normalizeConfig, validOptionalUrl } from './qa/lib.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const HOST = '127.0.0.1';
const DATA = path.resolve(process.env.QA_DATA_DIR || path.join(ROOT, 'data'));
const PUBLIC = path.join(ROOT, 'public');
const RUNS = path.join(DATA, 'runs');
const PAIRS = path.join(DATA, 'pairs.json');
let activeChild = null;
let activeRunId = null;
let activeRunPhase = null;

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': mime['.json'], 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};
const dataPath = (name) => path.join(DATA, name);
const runPath = (id, name = '') => path.join(RUNS, id, name);

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, file);
}
async function getConfig() {
  const stored = await readJson(dataPath('config.json'), defaultConfig);
  return normalizeConfig(stored);
}
async function getHistory() {
  return readJson(dataPath('history.json'), []);
}
async function bodyJson(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new Error('Request is too large.');
  }
  return raw ? JSON.parse(raw) : {};
}
async function serveFile(response, filename) {
  const body = await fs.readFile(filename);
  const extension = path.extname(filename).toLowerCase();
  response.writeHead(200, { 'content-type': mime[extension] || 'application/octet-stream', 'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=300' });
  response.end(body);
}
function sendError(response, error, status = 400) {
  json(response, status, { error: error.message || 'Unexpected server error.' });
}

function normalizePairs(value) {
  if (!Array.isArray(value)) throw new Error('Page URL pairs must be a list.');
  if (value.length > 100) throw new Error('A maximum of 100 page pairs can be run at once.');
  const ids = new Set();
  return value.map((pair, index) => {
    const id = String(pair.id || randomUUID());
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || ids.has(id)) throw new Error('Each page pair needs a unique, valid ID.');
    ids.add(id);
    return {
      id,
      name: `Page ${index + 1}`,
      enabled: true,
      previewUrl: validOptionalUrl(pair.previewUrl, `Page ${index + 1} Preview URL`),
      liveUrl: validOptionalUrl(pair.liveUrl, `Page ${index + 1} Live URL`),
      productionUrl: '',
      figmaUrl: '',
      expectedTitle: '',
      expectedHeading: '',
      ignoreSelectors: [],
    };
  });
}

async function launchRun(response, { environment, mode, pages, task = null, viewports, accessibility = false, config }) {
  if (activeChild) return json(response, 409, { error: 'A test run is already in progress.' });
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const runInput = { runId, environment, mode, pages, task, viewports, accessibility, config, startedAt: new Date().toISOString() };
  await fs.mkdir(runPath(runId, 'artifacts'), { recursive: true });
  await writeJson(runPath(runId, 'input.json'), runInput);
  await writeJson(runPath(runId, 'status.json'), { runId, status: 'running', current: 'Preparing browser', startedAt: runInput.startedAt, progress: 0 });
  activeRunId = runId;
  activeRunPhase = 'running';
  activeChild = spawn(process.execPath, [path.join(ROOT, 'qa', 'runner.mjs'), runPath(runId, 'input.json')], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
  let lastError = '';
  activeChild.on('error', (error) => { lastError = error.message; });
  activeChild.stderr.on('data', (chunk) => { lastError = (lastError + chunk.toString()).slice(-8000); });
  activeChild.on('close', async (code, signal) => {
    activeRunPhase = 'finalizing';
    try {
      const report = await readJson(runPath(runId, 'report.json'), null);
      const status = await readJson(runPath(runId, 'status.json'), {});
      if (report) {
        const wasCancelled = signal === 'SIGTERM' || report.status === 'cancelled' || status.status === 'cancelled';
        report.status = wasCancelled ? 'cancelled' : code === 0 ? 'completed' : 'infrastructure-error';
        report.finishedAt = new Date().toISOString();
        if (lastError && code !== 0) report.runnerError = lastError;
        const history = await getHistory();
        const previousReports = await Promise.all(history.map(async (entry) => ({ entry, report: await readJson(runPath(entry.runId, 'report.json'), null) })));
        for (const issue of report.pages.flatMap((page) => page.issues || [])) {
          const previous = previousReports.map(({ entry, report: prior }) => ({ entry, issue: prior?.pages.flatMap((page) => page.issues || []).find((item) => item.fingerprint === issue.fingerprint) })).find((item) => item.issue);
          issue.lastDetectedRun = runId;
          issue.lastDetectedAt = report.finishedAt;
          if (previous) {
            issue.firstDetectedRun = previous.issue.firstDetectedRun || previous.entry.runId;
            issue.firstDetectedAt = previous.issue.firstDetectedAt || previous.entry.startedAt;
            if (previous.issue.status !== 'resolved') issue.status = previous.issue.status || 'open';
          } else {
            issue.firstDetectedRun = runId;
            issue.firstDetectedAt = report.startedAt;
          }
        }
        await writeJson(runPath(runId, 'report.json'), report);
        history.unshift({ runId, status: report.status, environment, mode, startedAt: report.startedAt, finishedAt: report.finishedAt, pageCount: report.pages.length, passed: report.summary.passed, failed: report.summary.failed, issues: report.summary.issues, visualDifferences: report.summary.visualDifferences, functionalFailures: report.summary.functionalFailures, accessibilityViolations: report.summary.accessibilityViolations, durationMs: report.durationMs });
        const keep = runInput.config.historyRetention;
        for (const oldRun of history.slice(keep)) await fs.rm(runPath(oldRun.runId), { recursive: true, force: true });
        await writeJson(dataPath('history.json'), history.slice(0, keep));
      } else {
        const wasCancelled = signal === 'SIGTERM' || status.status === 'cancelled';
        const finishedAt = new Date().toISOString();
        const terminalStatus = wasCancelled ? 'cancelled' : 'infrastructure-error';
        const summary = { pages: 0, passed: 0, failed: 0, issues: 0, visualDifferences: 0, functionalFailures: 0, accessibilityViolations: 0 };
        const fallbackReport = {
          runId,
          status: terminalStatus,
          environment,
          mode,
          viewports,
          startedAt: runInput.startedAt,
          finishedAt,
          durationMs: Date.now() - Date.parse(runInput.startedAt),
          pages: [],
          checks: [],
          summary,
          runnerError: lastError || (wasCancelled ? 'Cancelled before the browser runner produced a report.' : `Runner exited with code ${code} before producing a report.`),
        };
        await writeJson(runPath(runId, 'report.json'), fallbackReport);
        await writeJson(runPath(runId, 'status.json'), { ...status, runId, status: terminalStatus, current: wasCancelled ? 'Cancelled' : 'Runner failed', progress: 100, error: fallbackReport.runnerError, summary });
        await fs.writeFile(runPath(runId, 'report.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>QA run ${runId}</title><body><h1>QA run ${terminalStatus}</h1><p>${fallbackReport.runnerError}</p></body></html>`);
        const history = await getHistory();
        history.unshift({ runId, status: terminalStatus, environment, mode, startedAt: runInput.startedAt, finishedAt, pageCount: 0, passed: 0, failed: 0, issues: 0, visualDifferences: 0, functionalFailures: 0, accessibilityViolations: 0, durationMs: fallbackReport.durationMs });
        const keep = runInput.config.historyRetention;
        for (const oldRun of history.slice(keep)) await fs.rm(runPath(oldRun.runId), { recursive: true, force: true });
        await writeJson(dataPath('history.json'), history.slice(0, keep));
      }
    } catch (error) {
      console.error('Could not finalize test run:', error);
    }
    activeChild = null;
    activeRunId = null;
    activeRunPhase = null;
  });
  return json(response, 202, { runId, status: 'running' });
}

async function runRoute(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/pairs') {
    let pairs = await readJson(PAIRS, null);
    if (!pairs) {
      const legacy = await getConfig();
      pairs = normalizePairs(legacy.pages.filter((page) => page.previewUrl || page.liveUrl));
      await writeJson(PAIRS, pairs);
    }
    return json(response, 200, pairs);
  }
  if (request.method === 'PUT' && url.pathname === '/api/pairs') {
    const pairs = normalizePairs((await bodyJson(request)).pairs);
    await writeJson(PAIRS, pairs);
    return json(response, 200, pairs);
  }
  if (request.method === 'POST' && url.pathname === '/api/pair-runs') {
    const { pairs: requestedPairs } = await bodyJson(request);
    const pairs = normalizePairs(requestedPairs);
    if (!pairs.length) return json(response, 400, { error: 'Add at least one Preview/Live URL pair before running tests.' });
    for (const pair of pairs) {
      if (!pair.previewUrl || !pair.liveUrl) return json(response, 400, { error: `${pair.name} needs both a valid Preview URL and a valid Live URL.` });
    }
    return launchRun(response, {
      environment: 'preview',
      mode: 'full',
      pages: pairs,
      viewports: ['desktop', 'mobile'],
      accessibility: false,
      config: await getConfig(),
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/config') return json(response, 200, await getConfig());
  if (request.method === 'PUT' && url.pathname === '/api/config') {
    const config = normalizeConfig(await bodyJson(request));
    await writeJson(dataPath('config.json'), config);
    return json(response, 200, config);
  }
  if (request.method === 'GET' && url.pathname === '/api/runs') return json(response, 200, await getHistory());
  if (request.method === 'GET' && url.pathname.startsWith('/api/runs/')) {
    const id = url.pathname.split('/')[3];
    if (id === activeRunId && activeChild) {
      const status = await readJson(runPath(id, 'status.json'), { runId: id });
      if (activeRunPhase === 'finalizing') return json(response, 200, { ...status, status: 'running', current: 'Finalizing report and history', progress: 99 });
      if (status.status !== 'running') return json(response, 200, { ...status, status: 'running', current: status.current || 'Finishing browser checks' });
      return json(response, 200, status);
    }
    const report = await readJson(runPath(id, 'report.json'), null);
    const state = await readJson(runPath(id, 'status.json'), null);
    if (!report && !state) return json(response, 404, { error: 'Run not found.' });
    return json(response, 200, report || state);
  }
  if (request.method === 'POST' && url.pathname === '/api/demo') {
    const config = await getConfig();
    const pageId = 'demo-store-page';
    const taskId = 'demo-failing-task';
    const origin = `http://${HOST}:${PORT}/demo`;
    config.pages = config.pages.filter((page) => page.id !== pageId);
    config.tasks = config.tasks.filter((task) => task.id !== taskId);
    config.pages.push({ id: pageId, name: 'Local demo storefront', enabled: true, liveUrl: `${origin}/reference`, previewUrl: `${origin}/changed`, productionUrl: `${origin}/reference`, figmaUrl: '', expectedTitle: 'Demo storefront', expectedHeading: 'A calmer daily routine', ignoreSelectors: [] });
    config.tasks.push({ id: taskId, name: 'Demo: intentionally missing confirmation', pageId, expectedResult: 'A visible confirmation reading "Added to cart" appears after clicking the demo button.', steps: [{ action: 'clickRole', value: 'button', name: 'Add to cart' }, { action: 'expectText', value: 'Added to cart' }], approved: true });
    await writeJson(dataPath('config.json'), normalizeConfig(config));
    return json(response, 200, { message: 'Demo page and an intentionally failing, safe local task are ready.', config });
  }
  if (request.method === 'POST' && url.pathname === '/api/runs') {
    if (activeChild) return json(response, 409, { error: 'A test run is already in progress.' });
    const input = await bodyJson(request);
    if (input.authorized !== true) return json(response, 400, { error: 'Confirm that you are authorized to test the configured URLs.' });
    const config = await getConfig();
    const environment = input.environment;
    if (!['preview', 'production'].includes(environment)) return json(response, 400, { error: 'Select Preview or Production.' });
    const mode = input.mode;
    if (!['full', 'ui', 'functional', 'task'].includes(mode)) return json(response, 400, { error: 'Select a supported test mode.' });
    if (mode === 'task' && environment !== 'preview') return json(response, 400, { error: 'Specific task runs are limited to Preview to avoid unintended production changes.' });
    const requestedIds = Array.isArray(input.pageIds) ? input.pageIds : [];
    const pages = config.pages.filter((page) => page.enabled && (!requestedIds.length || requestedIds.includes(page.id)));
    if (!pages.length) return json(response, 400, { error: 'Select at least one enabled page.' });
    for (const page of pages) {
      const targetUrl = page[`${environment}Url`];
      if (!targetUrl) return json(response, 400, { error: `${page.name} needs a ${environment} URL before it can be tested.` });
      validOptionalUrl(targetUrl, `${page.name} ${environment} URL`);
    }
    let task = null;
    if (mode === 'task') {
      task = config.tasks.find((item) => item.id === input.taskId && item.approved);
      if (!task) return json(response, 400, { error: 'Choose a saved, reviewed, approved task specification.' });
      if (!pages.some((page) => page.id === task.pageId)) return json(response, 400, { error: 'The selected page list does not include the task page.' });
    }
    const viewports = input.viewports === 'both' ? ['desktop', 'mobile'] : [input.viewports === 'mobile' ? 'mobile' : 'desktop'];
    return launchRun(response, { environment, mode, pages, task, viewports, accessibility: input.accessibility === true, config });
  }
  if (request.method === 'POST' && url.pathname.startsWith('/api/runs/') && url.pathname.endsWith('/cancel')) {
    const id = url.pathname.split('/')[3];
    if (id !== activeRunId || !activeChild) return json(response, 409, { error: 'That run is no longer active.' });
    activeChild.kill('SIGTERM');
    return json(response, 202, { message: 'Cancellation requested.' });
  }
  if (request.method === 'POST' && url.pathname === '/api/baselines/approve') {
    const { runId, pageId, viewport } = await bodyJson(request);
    if (!['desktop', 'mobile'].includes(viewport)) return json(response, 400, { error: 'Select a valid viewport.' });
    const report = await readJson(runPath(runId, 'report.json'), null);
    const pageResult = report?.pages.find((item) => item.pageId === pageId);
    const screenshot = pageResult?.screenshots?.[viewport]?.target;
    if (!screenshot) return json(response, 404, { error: 'Target screenshot was not found in that run.' });
    const source = path.resolve(DATA, screenshot.replace(/^\/+/, ''));
    const sourceRelative = path.relative(DATA, source);
    if (!sourceRelative || sourceRelative.startsWith('..') || path.isAbsolute(sourceRelative)) return json(response, 400, { error: 'Invalid screenshot path.' });
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(pageId))) return json(response, 400, { error: 'Invalid page ID.' });
    const destination = path.join(DATA, 'baselines', `${pageId}-${viewport}.png`);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    return json(response, 200, { message: 'Approved baseline saved. Ordinary runs will not overwrite it.' });
  }
  if (request.method === 'POST' && /^\/api\/runs\/[^/]+\/issues\/[^/]+$/.test(url.pathname)) {
    const [, , , runId, , issueId] = url.pathname.split('/');
    const { status } = await bodyJson(request);
    if (!['open', 'reviewed', 'resolved'].includes(status)) return json(response, 400, { error: 'Issue status must be open, reviewed, or resolved.' });
    const report = await readJson(runPath(runId, 'report.json'), null);
    if (!report) return json(response, 404, { error: 'Run report not found.' });
    const issue = report.pages.flatMap((page) => page.issues || []).find((item) => item.id === issueId);
    if (!issue) return json(response, 404, { error: 'Issue not found.' });
    issue.status = status;
    issue.statusUpdatedAt = new Date().toISOString();
    await writeJson(runPath(runId, 'report.json'), report);
    return json(response, 200, { issue });
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/evidence/')) {
    const [, , , runId, ...fileParts] = url.pathname.split('/');
    const filename = path.resolve(runPath(runId), ...fileParts);
    if (!filename.startsWith(`${runPath(runId)}${path.sep}`)) return json(response, 400, { error: 'Invalid evidence path.' });
    return serveFile(response, filename);
  }
  return json(response, 404, { error: 'API route not found.' });
}

const demoMarkup = (changed) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demo storefront</title><style>*{box-sizing:border-box}body{margin:0;background:${changed ? '#eff3e8' : '#fff'};color:#173c32;font:17px Georgia,serif}.hero{min-height:68vh;display:grid;place-content:center;text-align:center;padding:32px;background:${changed ? '#d8e8b9' : '#edf2e7'}}h1{max-width:650px;font-size:clamp(38px,7vw,72px);font-weight:400;margin:0 auto 16px}.button{padding:13px 20px;background:#174c39;color:#fff;border:0;font:700 14px sans-serif;cursor:pointer}.changed .button{border-radius:24px;background:#c45a40}.note{max-width:620px;margin:30px auto;line-height:1.6}</style></head><body class="${changed ? 'changed' : ''}"><main><section class="hero"><p>LOCAL QA FIXTURE · ${changed ? 'PREVIEW' : 'REFERENCE'}</p><h1>A calmer daily routine</h1><button class="button" onclick="document.querySelector('#message').textContent='Demo item added.'">Add to cart</button><p id="message" aria-live="polite"></p></section><p class="note">This local-only fixture demonstrates a deliberate visual difference. The preview button also intentionally does not show the task's expected confirmation.</p></main></body></html>`;

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${HOST}:${PORT}`);
    if (url.pathname.startsWith('/api/')) return await runRoute(request, response, url);
    if (url.pathname === '/README.md' || url.pathname === '/TEST-CASES.md') return await serveFile(response, path.join(ROOT, url.pathname.slice(1)));
    if (url.pathname.startsWith('/demo/')) {
      if (request.method !== 'GET') return json(response, 405, { error: 'Method not allowed.' });
      const variant = url.pathname.endsWith('/changed');
      response.writeHead(200, { 'content-type': mime['.html'], 'cache-control': 'no-store' });
      return response.end(demoMarkup(variant));
    }
    if (request.method !== 'GET') return json(response, 405, { error: 'Method not allowed.' });
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const filename = path.resolve(PUBLIC, relative);
    if (!filename.startsWith(`${PUBLIC}${path.sep}`) && filename !== path.join(PUBLIC, 'index.html')) return json(response, 403, { error: 'Forbidden.' });
    await serveFile(response, filename);
  } catch (error) {
    if (!response.headersSent) sendError(response, error, error.code === 'ENOENT' ? 404 : 500);
    else response.end();
  }
});

await fs.mkdir(RUNS, { recursive: true });
server.listen(PORT, HOST, () => console.log(`GleeFull QA dashboard running at http://${HOST}:${PORT}`));
