import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function launch(port, dataDir) {
  const child = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, env: { ...process.env, PORT: String(port), QA_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const limit = Date.now() + 8_000;
  while (Date.now() < limit) {
    if (child.exitCode !== null) throw new Error(`Dashboard process exited: ${output}`);
    try { await fetch(`${base}/api/config`); return { child, base, output: () => output }; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  child.kill('SIGTERM');
  throw new Error(`Dashboard did not start: ${output}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('close', resolve));
}

async function waitForRun(base, runId, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}`);
    const run = await response.json();
    if (run.status !== 'running') return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Run ${runId} did not finish within ${timeoutMs} ms.`);
}

test('configuration persistence and test-run locking survive normal and error completion', { timeout: 90_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gleefull-config-'));
  const port = await freePort();
  let processInfo;
  let fixtureServer;
  try {
    processInfo = await launch(port, dataDir);
    const response = await fetch(`${processInfo.base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetEnvironment: 'preview', liveBaseUrl: 'https://live.example.test', previewBaseUrl: 'https://preview.example.test', productionBaseUrl: 'https://shop.example.test', visualThreshold: 0.7, historyRetention: 12, tasks: [], pages: [{ id: 'persisted', name: 'Different environment routes', liveUrl: 'https://live.example.test/a', previewUrl: 'https://preview.example.test/b', productionUrl: 'https://shop.example.test/c' }] }) });
    assert.equal(response.status, 200);
    await stop(processInfo.child);
    processInfo = await launch(port, dataDir);
    const restored = await fetch(`${processInfo.base}/api/config`).then((result) => result.json());
    assert.equal(restored.pages[0].name, 'Different environment routes');
    assert.equal(restored.pages[0].previewUrl, 'https://preview.example.test/b');
    assert.equal(restored.pages[0].productionUrl, 'https://shop.example.test/c');
    assert.equal(restored.visualThreshold, 0.7);
    assert.equal(restored.historyRetention, 12);

    const pairResponse = await fetch(`${processInfo.base}/api/pairs`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairs: [{ id: 'homepage', previewUrl: 'https://preview.example.test/', liveUrl: 'https://live.example.test/' }] }) });
    assert.equal(pairResponse.status, 200);
    await stop(processInfo.child);
    processInfo = await launch(port, dataDir);
    const savedPairs = await fetch(`${processInfo.base}/api/pairs`).then((result) => result.json());
    assert.equal(savedPairs.length, 1);
    assert.equal(savedPairs[0].previewUrl, 'https://preview.example.test');
    assert.equal(savedPairs[0].liveUrl, 'https://live.example.test');
    const invalidRun = await fetch(`${processInfo.base}/api/pair-runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairs: [{ id: 'empty-pair', previewUrl: '', liveUrl: '' }] }) });
    assert.equal(invalidRun.status, 400);

    fixtureServer = http.createServer((request, response) => {
      const isError = request.url === '/error';
      const isPreview = request.url === '/preview';
      response.writeHead(isError ? 500 : 200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Run lock fixture</title><style>body{background:${isPreview ? '#e4edce' : '#fff'}}</style></head><body><main><h1>Fixture page</h1></main></body></html>`);
    });
    await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
    const fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;
    const validPair = { id: 'run-lock', previewUrl: `${fixtureBase}/preview`, liveUrl: `${fixtureBase}/live` };
    const firstRunResponse = await fetch(`${processInfo.base}/api/pair-runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairs: [validPair] }) });
    assert.equal(firstRunResponse.status, 202);
    const firstRunId = (await firstRunResponse.json()).runId;
    const activeStatus = await fetch(`${processInfo.base}/api/runs/${firstRunId}`).then((result) => result.json());
    assert.equal(activeStatus.status, 'running');
    assert.notEqual(activeStatus.current, 'Finalizing report and history');
    const duplicateResponse = await fetch(`${processInfo.base}/api/pair-runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairs: [validPair] }) });
    assert.equal(duplicateResponse.status, 409);
    assert.match((await duplicateResponse.json()).error, /already in progress/);
    const firstRun = await waitForRun(processInfo.base, firstRunId);
    assert.equal(firstRun.status, 'completed', JSON.stringify(firstRun));

    const errorPair = { ...validPair, previewUrl: `${fixtureBase}/error` };
    const errorRunResponse = await fetch(`${processInfo.base}/api/pair-runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairs: [errorPair] }) });
    assert.equal(errorRunResponse.status, 202, 'run lock must reset after normal completion');
    const errorRunId = (await errorRunResponse.json()).runId;
    const errorRun = await waitForRun(processInfo.base, errorRunId);
    assert.equal(errorRun.status, 'completed');
    assert.ok(errorRun.summary.failed > 0, 'HTTP error page should be recorded as failed checks');
    const afterErrorResponse = await fetch(`${processInfo.base}/api/pair-runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairs: [validPair] }) });
    assert.equal(afterErrorResponse.status, 202, 'run lock must reset after a page error');
    const afterErrorId = (await afterErrorResponse.json()).runId;
    await fetch(`${processInfo.base}/api/runs/${afterErrorId}/cancel`, { method: 'POST' });
    const cancelledRun = await waitForRun(processInfo.base, afterErrorId);
    assert.equal(cancelledRun.status, 'cancelled');
    const cancelledHistory = await fetch(`${processInfo.base}/api/runs`).then((result) => result.json());
    assert.equal(cancelledHistory.find((entry) => entry.runId === afterErrorId).status, 'cancelled');
    const afterCancelResponse = await fetch(`${processInfo.base}/api/pair-runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairs: [validPair] }) });
    assert.equal(afterCancelResponse.status, 202, 'run lock must reset after cancellation');
    const finalRunId = (await afterCancelResponse.json()).runId;
    await fetch(`${processInfo.base}/api/runs/${finalRunId}/cancel`, { method: 'POST' });
    await waitForRun(processInfo.base, finalRunId);
        
        const runId = 'baseline-path-test';
        const runDirectory = path.join(dataDir, 'runs', runId);
        await fs.mkdir(path.join(runDirectory, 'artifacts'), { recursive: true });
        await fs.writeFile(path.join(runDirectory, 'artifacts', 'target.png'), 'controlled test data');
        await fs.writeFile(path.join(runDirectory, 'report.json'), JSON.stringify({ pages: [{ pageId: '../outside', screenshots: { desktop: { target: `runs/${runId}/artifacts/target.png` } } }] }));
        const baselineResponse = await fetch(`${processInfo.base}/api/baselines/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId, pageId: '../outside', viewport: 'desktop' }),
        });
        assert.equal(baselineResponse.status, 400);
        await assert.rejects(fs.access(path.join(dataDir, 'outside-desktop.png')));
  } finally {
    if (fixtureServer?.listening) await new Promise((resolve) => fixtureServer.close(resolve));
    if (processInfo?.child) await stop(processInfo.child);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
