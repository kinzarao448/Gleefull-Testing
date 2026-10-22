const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const formatDate = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
let pairs = [];
let currentRunId = null;
let currentReport = null;
let saveTimer = null;
let saveQueue = Promise.resolve();
let toastTimer = null;
let pairRevision = 0;
let pollFailures = 0;

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}
function notify(message, isError = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4200);
}
function renderPairs() {
  $('#pairCount').textContent = `${pairs.length} ${pairs.length === 1 ? 'page' : 'pages'}`;
    $('#pairsBody').innerHTML = pairs.length ? pairs.map((pair, index) => `<tr data-pair="${escapeHtml(pair.id)}"><td><label class="sr-only" for="preview-${escapeHtml(pair.id)}">Preview Link (DEV), page ${index + 1}</label><input class="pair-input" id="preview-${escapeHtml(pair.id)}" data-field="previewUrl" type="url" required autocomplete="url" placeholder="https://preview.example.com/page" value="${escapeHtml(pair.previewUrl)}"></td><td><label class="sr-only" for="live-${escapeHtml(pair.id)}">Live Link (PROD), page ${index + 1}</label><input class="pair-input" id="live-${escapeHtml(pair.id)}" data-field="liveUrl" type="url" required autocomplete="url" placeholder="https://www.example.com/page" value="${escapeHtml(pair.liveUrl)}"></td><td class="delete-cell"><button class="delete-button" type="button" data-delete="${escapeHtml(pair.id)}" aria-label="Delete page ${index + 1}" title="Delete page">×</button></td></tr>`).join('') : '<tr><td colspan="3" class="empty-row">No pages yet. Select + Add Page to enter a Preview/Live pair.</td></tr>';
  $$('[data-field]').forEach((input) => input.addEventListener('input', () => {
    const row = input.closest('[data-pair]');
    const pair = pairs.find((item) => item.id === row.dataset.pair);
    pair[input.dataset.field] = input.value.trim();
    scheduleSave();
  }));
  $$('[data-delete]').forEach((button) => button.addEventListener('click', () => {
    pairs = pairs.filter((pair) => pair.id !== button.dataset.delete);
    pairRevision += 1;
    renderPairs();
    savePairs();
  }));
}
function scheduleSave() {
  pairRevision += 1;
  clearTimeout(saveTimer);
  if (!pairs.every((pair) => [pair.previewUrl, pair.liveUrl].every(isValidOrBlankUrl))) {
    $('#saveStatus').textContent = 'Finish entering a valid URL to save.';
    return;
  }
  $('#saveStatus').textContent = 'Saving…';
  saveTimer = setTimeout(savePairs, 450);
}
function isValidOrBlankUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
async function savePairs() {
  clearTimeout(saveTimer);
  if (!pairs.every((pair) => [pair.previewUrl, pair.liveUrl].every(isValidOrBlankUrl))) return false;
  const revision = pairRevision;
  const snapshot = structuredClone(pairs);
  const pendingSave = saveQueue.catch(() => {}).then(() => api('/api/pairs', { method: 'PUT', body: JSON.stringify({ pairs: snapshot }) }));
  saveQueue = pendingSave;
  try {
    const saved = await pendingSave;
    if (revision === pairRevision) {
      pairs = saved;
      $('#saveStatus').textContent = 'Saved automatically';
    } else {
      $('#saveStatus').textContent = 'Saving…';
      saveTimer = setTimeout(savePairs, 0);
    }
    return true;
  } catch (error) {
    $('#saveStatus').textContent = 'Could not save';
    notify(error.message, true);
    return false;
  }
}
function addPair() {
  if (pairs.length >= 100) return notify('You can save up to 100 page pairs.', true);
  pairs.push({ id: crypto.randomUUID(), previewUrl: '', liveUrl: '' });
  pairRevision += 1;
  renderPairs();
  savePairs();
  const input = $$('#pairsBody [data-field="previewUrl"]').at(-1);
  input?.focus();
}
function setRunning(running) {
  $('#runRegression').disabled = running;
  $('#addPage').disabled = running;
  $$('.delete-button').forEach((button) => { button.disabled = running; });
  $('#progress').hidden = !running;
}
async function runRegression() {
  if (!pairs.length) return notify('Add at least one Preview/Live URL pair first.', true);
  if (!$('#pairsForm').reportValidity()) return;
  try {
    if (!await savePairs()) return notify('Complete both Preview and Live URLs with valid addresses before running.', true);
    const result = await api('/api/pair-runs', { method: 'POST', body: JSON.stringify({ pairs }) });
    currentRunId = result.runId;
    currentReport = null;
    pollFailures = 0;
    $('#summary').innerHTML = '<p class="empty-state">Regression is running. Each URL pair is checked independently.</p>';
    $('#issueList').replaceChildren();
    $('#htmlReport').hidden = true;
    setRunning(true);
    pollRun();
  } catch (error) { notify(error.message, true); }
}
async function pollRun() {
  if (!currentRunId) return;
  try {
    const run = await api(`/api/runs/${encodeURIComponent(currentRunId)}`);
    pollFailures = 0;
    if (run.status === 'running') {
      $('#progressLabel').textContent = run.current || 'Checking pages';
      $('#progressPercent').textContent = `${run.progress ?? 0}%`;
      $('#progressBar').value = run.progress ?? 0;
      setTimeout(pollRun, 850);
      return;
    }
    setRunning(false);
    if (!run.checks) throw new Error(run.error || 'The browser runner did not produce a report.');
    currentReport = run;
    renderReport(run);
    renderHistory(await api('/api/runs'));
    $('#htmlReport').href = `/api/evidence/${encodeURIComponent(run.runId)}/report.html`;
    $('#htmlReport').hidden = false;
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    notify(run.status === 'cancelled' ? 'Run cancelled. Partial results are shown.' : run.summary.issues ? `Run complete: ${run.summary.issues} issue(s) need review.` : 'Run complete: no issues found.');
  } catch (error) {
    if (error.status === 404) {
      setRunning(false);
      $('#runRegression').disabled = false;
      $('#summary').innerHTML = `<p class="run-error">${escapeHtml(error.message)}</p>`;
      notify(error.message, true);
      return;
    }
    pollFailures += 1;
    $('#progressLabel').textContent = `Connection interrupted · retrying (${pollFailures})`;
    setTimeout(pollRun, 1_000);
  }
}
function renderReport(report) {
  const summary = report.summary;
  $('#summary').innerHTML = `<div class="summary-stats"><div><strong>${summary.pages}</strong><span>Pages checked</span></div><div><strong>${summary.passed}</strong><span>Checks passed</span></div><div><strong>${summary.failed}</strong><span>Checks failed</span></div><div><strong>${summary.issues}</strong><span>Issues found</span></div></div><p class="run-meta">${escapeHtml(report.environment)} · ${formatDate(report.startedAt)} · ${(report.durationMs / 1000).toFixed(1)} sec</p>`;
  $('#issueList').innerHTML = report.pages.map((page, index) => {
    const checks = report.checks.filter((check) => check.pageId === page.pageId);
    const issues = page.issues || [];
    const screenshotLinks = Object.entries(page.screenshots || {}).map(([viewport, shots]) => {
      const target = `/api/evidence/${report.runId}/${(shots.targetViewport || shots.target).replace(`runs/${report.runId}/`, '')}`;
      const live = `/api/evidence/${report.runId}/${(shots.liveViewport || shots.live).replace(`runs/${report.runId}/`, '')}`;
      return `<div class="screenshot-pair"><a href="${escapeHtml(target)}" target="_blank"><img loading="lazy" src="${escapeHtml(target)}" alt="Preview page ${index + 1}, ${escapeHtml(viewport)}"><span>Preview · ${escapeHtml(viewport)}</span></a><a href="${escapeHtml(live)}" target="_blank"><img loading="lazy" src="${escapeHtml(live)}" alt="Live page ${index + 1}, ${escapeHtml(viewport)}"><span>Live · ${escapeHtml(viewport)}</span></a></div>`;
    }).join('');
    const diffs = (page.visual || []).filter((item) => item.comparison === 'live-reference').map((visual) => `<a class="diff-link" href="/api/evidence/${report.runId}/${visual.diff.replace(`runs/${report.runId}/`, '')}" target="_blank">Open ${escapeHtml(visual.viewport)} visual diff · ${visual.percent.toFixed(2)}% changed</a>`).join('');
    return `<article class="page-result"><div class="page-result-head"><div><p class="eyebrow">PAGE ${index + 1}</p><h3>${escapeHtml(page.pageName)}</h3><a class="target-url" href="${escapeHtml(page.urls.target)}" target="_blank" rel="noreferrer">${escapeHtml(page.urls.target)}</a></div><span class="page-outcome ${issues.length ? 'has-issues' : 'clear'}">${issues.length ? `${issues.length} issue${issues.length === 1 ? '' : 's'}` : 'No issues'}</span></div>${issues.length ? issues.map((issue) => `<section class="issue"><div class="issue-title"><span class="severity ${escapeHtml(issue.severity.toLowerCase())}">${escapeHtml(issue.severity)}</span><span class="category">${escapeHtml(issue.category)}</span><h4>${escapeHtml(issue.title)}</h4></div><p>${escapeHtml(issue.summary)}</p><dl><dt>Expected</dt><dd>${escapeHtml(issue.expected || 'No explicit expectation was set.')}</dd><dt>Observed</dt><dd>${escapeHtml(issue.actual || 'See evidence below.')}</dd><dt>Detected at</dt><dd><a href="${escapeHtml(issue.url || page.urls.target)}" target="_blank" rel="noreferrer">${escapeHtml(issue.url || page.urls.target)}</a></dd><dt>Next step</dt><dd>${escapeHtml(issue.nextAction || 'Review the page and reproduce the issue.')}</dd></dl><div class="evidence-links">${(issue.evidence || []).map((link) => `<a href="${escapeHtml(link)}" target="_blank" rel="noreferrer">Open evidence ↗</a>`).join('')}</div></section>`).join('') : `<p class="no-issues">${checks.length} checks passed for this page.</p>`}${screenshotLinks}${diffs ? `<div class="diff-links">${diffs}</div>` : ''}</article>`;
  }).join('');
}
function renderHistory(entries = []) {
  const recent = entries.slice(0, 8);
  $('#historyCount').textContent = recent.length ? `${recent.length} recent` : '';
  $('#historyList').innerHTML = recent.length ? recent.map((entry) => `<button type="button" class="history-row" data-open-run="${escapeHtml(entry.runId)}"><span>${formatDate(entry.startedAt)}</span><span>${entry.pageCount} page${entry.pageCount === 1 ? '' : 's'}</span><span>${entry.issues} issue${entry.issues === 1 ? '' : 's'}</span><span>${entry.failed} failed checks</span></button>`).join('') : '<p class="empty-state">No completed runs yet.</p>';
  $$('[data-open-run]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const report = await api(`/api/runs/${encodeURIComponent(button.dataset.openRun)}`);
      if (!report.checks) throw new Error(report.error || 'Detailed report not found.');
      currentRunId = report.runId;
      currentReport = report;
      renderReport(report);
      $('#htmlReport').href = `/api/evidence/${encodeURIComponent(report.runId)}/report.html`;
      $('#htmlReport').hidden = false;
      $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) { notify(error.message, true); }
  }));
}
async function load() {
  try {
    pairs = await api('/api/pairs');
    if (!pairs.length) pairs = [{ id: crypto.randomUUID(), previewUrl: '', liveUrl: '' }];
    renderPairs();
    renderHistory(await api('/api/runs'));
    $('#saveStatus').textContent = 'Changes save automatically.';
  } catch (error) { notify(`Could not load the dashboard: ${error.message}`, true); }
}

$('#addPage').addEventListener('click', addPair);
$('#runRegression').addEventListener('click', runRegression);
load();
