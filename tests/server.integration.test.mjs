import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
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

test('saved page configuration survives a dashboard process restart', { timeout: 20_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gleefull-config-'));
  const port = await freePort();
  let processInfo;
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
    if (processInfo?.child) await stop(processInfo.child);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
