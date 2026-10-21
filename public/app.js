const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const dateFormat = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const shortUrl = (value) => { try { const url = new URL(value); return `${url.host}${url.pathname}`; } catch { return value || 'Not configured'; } };
let config;
let history = [];
let currentRunId = null;
let currentReport = null;
let toastTimer;
const selectedIds = new Set();

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}
function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('error', error);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3600);
}
function value(id) { return $(`#${id}`).value; }
function setValue(id, content) { $(`#${id}`).value = content ?? ''; }

async function load() {
  try {
    [config, history] = await Promise.all([api('/api/config'), api('/api/runs')]);
    if (!selectedIds.size) config.pages.filter((page) => page.enabled).forEach((page) => selectedIds.add(page.id));
    $('#environment').value = config.targetEnvironment || 'preview';
    $('#today').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date());
    renderConfig();
    renderPages();
    renderTasks();
    renderHistory();
    updateOverview();
  } catch (error) { toast(`Could not load the local QA workspace: ${error.message}`, true); }
}
function renderConfig() {
  for (const id of ['liveBaseUrl', 'previewBaseUrl', 'productionBaseUrl', 'visualThreshold', 'historyRetention']) setValue(id, config[id]);
  $('#retentionLabel').textContent = `Keeping up to ${config.historyRetention} run reports locally.`;
}
function renderPages() {
  const body = $('#pagesBody');
  if (!config.pages.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty-state">No pages saved yet. Add a page or load the local demo.</td></tr>';
  } else {
    body.innerHTML = config.pages.map((page) => {
      const isSelected = selectedIds.has(page.id);
      return `<tr data-page-row="${esc(page.id)}"><td><input class="row-check page-select" type="checkbox" value="${esc(page.id)}" ${isSelected && page.enabled ? 'checked' : ''} ${page.enabled ? '' : 'disabled'} aria-label="Select ${esc(page.name)} for test run"></td><td class="page-name">${esc(page.name)}</td><td class="url-cell" title="${esc(page.liveUrl)}">${page.liveUrl ? `<a href="${esc(page.liveUrl)}" target="_blank" rel="noreferrer">${esc(shortUrl(page.liveUrl))}</a>` : 'Not configured'}</td><td class="url-cell" title="${esc(page.previewUrl)}">${page.previewUrl ? `<a href="${esc(page.previewUrl)}" target="_blank" rel="noreferrer">${esc(shortUrl(page.previewUrl))}</a>` : 'Not configured'}</td><td class="url-cell" title="${esc(page.productionUrl)}">${page.productionUrl ? `<a href="${esc(page.productionUrl)}" target="_blank" rel="noreferrer">${esc(shortUrl(page.productionUrl))}</a>` : 'Not configured'}</td><td><span class="status-tag ${page.enabled ? '' : 'off'}">${page.enabled ? 'Enabled' : 'Disabled'}</span></td><td><div class="row-actions"><button class="text-button" type="button" data-edit-page="${esc(page.id)}">Edit</button><button class="text-button delete" type="button" data-delete-page="${esc(page.id)}">Delete</button></div></td></tr>`;
    }).join('');
  }
  $('#pageCountHint').textContent = `${config.pages.length} saved page${config.pages.length === 1 ? '' : 's'} · ${config.pages.filter((page) => page.enabled).length} enabled. Select rows to run a subset; no selection means all enabled pages.`;
  $('#selectAllPages').checked = config.pages.filter((page) => page.enabled).length > 0 && config.pages.filter((page) => page.enabled).every((page) => selectedIds.has(page.id));
  $$('.page-select').forEach((checkbox) => checkbox.addEventListener('change', () => {
    if (checkbox.checked) selectedIds.add(checkbox.value); else selectedIds.delete(checkbox.value);
    renderPages();
  }));
  $$('[data-edit-page]').forEach((button) => button.addEventListener('click', () => editPage(button.dataset.editPage)));
  $$('[data-delete-page]').forEach((button) => button.addEventListener('click', () => deletePage(button.dataset.deletePage)));
  updateOverview();
}
function renderTasks() {
  const container = $('#tasksList');
  const approved = config.tasks.filter((task) => task.approved);
  $('#taskPicker').innerHTML = '<option value="">Choose a task</option>' + approved.map((task) => `<option value="${esc(task.id)}">${esc(task.name)}</option>`).join('');
  $('#taskPage').innerHTML = config.pages.map((page) => `<option value="${esc(page.id)}">${esc(page.name)}</option>`).join('');
  container.innerHTML = config.tasks.length ? config.tasks.map((task) => `<article class="task-row"><strong class="task-title">${esc(task.name)}</strong><span class="task-expected">${esc(task.expectedResult)}</span><span class="task-state ${task.approved ? 'approved' : ''}">${task.approved ? 'Approved · Preview' : 'Needs review'}</span><div class="actions"><button class="text-button" type="button" data-edit-task="${esc(task.id)}">Edit steps</button><button class="text-button delete" type="button" data-delete-task="${esc(task.id)}">Delete</button></div></article>`).join('') : '<p class="empty-state">No task specifications yet. Add a task with an explicit expected result and reviewed steps.</p>';
  $$('[data-edit-task]').forEach((button) => button.addEventListener('click', () => editTask(button.dataset.editTask)));
  $$('[data-delete-task]').forEach((button) => button.addEventListener('click', () => deleteTask(button.dataset.deleteTask)));
}
function updateOverview(report = currentReport) {
  $('#metricPages').textContent = config?.pages.length ?? 0;
  $('#metricEnabled').textContent = `${config?.pages.filter((page) => page.enabled).length ?? 0} enabled`;
  const latest = report || (history[0] && null);
  if (latest) {
    $('#metricPassed').textContent = latest.summary?.passed ?? 0;
    $('#metricRun').textContent = `${latest.summary?.failed ?? 0} failed · ${dateFormat(latest.startedAt)}`;
    $('#metricFailed').textContent = latest.summary?.failed ?? 0;
    $('#metricFunctional').textContent = `Functional: ${latest.summary?.functionalFailures ?? 0}`;
    $('#metricVisual').textContent = latest.summary?.visualDifferences ?? 0;
    $('#metricA11y').textContent = `Accessibility: ${latest.summary?.accessibilityViolations ?? 0}`;
  } else if (history.length) {
    const last = history[0];
    $('#metricPassed').textContent = last.passed ?? '—';
    $('#metricRun').textContent = `${last.failed ?? 0} failed · ${dateFormat(last.startedAt)}`;
    $('#metricFailed').textContent = last.failed ?? '—';
    $('#metricFunctional').textContent = `Functional: ${last.functionalFailures ?? '—'}`;
    $('#metricVisual').textContent = last.visualDifferences ?? '—';
    $('#metricA11y').textContent = `Accessibility: ${last.accessibilityViolations ?? '—'}`;
  } else {
    for (const id of ['metricPassed', 'metricFailed', 'metricVisual']) $(`#${id}`).textContent = '—';
    $('#metricRun').textContent = 'No runs yet';
    $('#metricFunctional').textContent = 'Functional: —';
    $('#metricA11y').textContent = 'Accessibility: —';
  }
}
async function saveConfig() {
  const next = { ...config };
  for (const id of ['liveBaseUrl', 'previewBaseUrl', 'productionBaseUrl']) next[id] = value(id).trim();
  next.visualThreshold = Number(value('visualThreshold'));
  next.historyRetention = Number(value('historyRetention'));
  try {
    config = await api('/api/config', { method: 'PUT', body: JSON.stringify(next) });
    renderConfig(); renderPages(); renderTasks(); renderHistory();
    toast('Configuration saved on this computer.');
  } catch (error) { toast(error.message, true); }
}
function editPage(pageId = '') {
  const page = config.pages.find((item) => item.id === pageId);
  $('#pageDialogTitle').textContent = page ? 'Edit page' : 'Add page';
  setValue('pageId', page?.id || '');
  setValue('pageName', page?.name || '');
  $('#pageEnabled').checked = page?.enabled !== false;
  setValue('pageLive', page?.liveUrl || config.liveBaseUrl);
  setValue('pagePreview', page?.previewUrl || config.previewBaseUrl);
  setValue('pageProduction', page?.productionUrl || config.productionBaseUrl);
  setValue('pageFigma', page?.figmaUrl || '');
  setValue('pageExpectedTitle', page?.expectedTitle || '');
  setValue('pageExpectedHeading', page?.expectedHeading || '');
  setValue('pageMasks', (page?.ignoreSelectors || []).join('\n'));
  $('#pageDialog').showModal();
}
$('#pageForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = value('pageId');
  const page = { id: id || crypto.randomUUID(), name: value('pageName').trim(), enabled: $('#pageEnabled').checked, liveUrl: value('pageLive').trim(), previewUrl: value('pagePreview').trim(), productionUrl: value('pageProduction').trim(), figmaUrl: value('pageFigma').trim(), expectedTitle: value('pageExpectedTitle').trim(), expectedHeading: value('pageExpectedHeading').trim(), ignoreSelectors: value('pageMasks').split('\n').map((item) => item.trim()).filter(Boolean) };
  const pages = id ? config.pages.map((item) => item.id === id ? page : item) : [...config.pages, page];
  try { config = await api('/api/config', { method: 'PUT', body: JSON.stringify({ ...config, pages }) }); if (!id && page.enabled) selectedIds.add(page.id); $('#pageDialog').close(); renderPages(); renderTasks(); toast('Page saved.'); }
  catch (error) { toast(error.message, true); }
});
async function deletePage(id) {
  const page = config.pages.find((item) => item.id === id);
  if (!page || !confirm(`Delete "${page.name}" and its task specifications?`)) return;
  const pages = config.pages.filter((item) => item.id !== id);
  const tasks = config.tasks.filter((task) => task.pageId !== id);
  try { config = await api('/api/config', { method: 'PUT', body: JSON.stringify({ ...config, pages, tasks }) }); selectedIds.delete(id); renderPages(); renderTasks(); toast('Page deleted.'); }
  catch (error) { toast(error.message, true); }
}
function editTask(taskId = '') {
  const task = config.tasks.find((item) => item.id === taskId);
  if (!config.pages.length) return toast('Add a page before creating a task spec.', true);
  $('#taskDialogTitle').textContent = task ? 'Edit task spec' : 'Create task spec';
  setValue('taskId', task?.id || '');
  setValue('taskName', task?.name || '');
  setValue('taskExpected', task?.expectedResult || '');
  setValue('taskSteps', JSON.stringify(task?.steps || [{ action: 'expectText', value: 'Replace with expected page text' }], null, 2));
  $('#taskPage').value = task?.pageId || config.pages[0].id;
  $('#taskApproved').checked = task?.approved || false;
  $('#taskDialog').showModal();
}
$('#taskForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  let steps;
  try { steps = JSON.parse(value('taskSteps')); if (!Array.isArray(steps) || !steps.length) throw new Error('Steps must be a non-empty JSON array.'); }
  catch (error) { return toast(`Task steps are not valid JSON: ${error.message}`, true); }
  const id = value('taskId');
  const task = { id: id || crypto.randomUUID(), name: value('taskName').trim(), pageId: value('taskPage'), expectedResult: value('taskExpected').trim(), steps, approved: $('#taskApproved').checked };
  const tasks = id ? config.tasks.map((item) => item.id === id ? task : item) : [...config.tasks, task];
  try { config = await api('/api/config', { method: 'PUT', body: JSON.stringify({ ...config, tasks }) }); $('#taskDialog').close(); renderTasks(); toast(task.approved ? 'Approved task specification saved.' : 'Task specification saved; review it before running.'); }
  catch (error) { toast(error.message, true); }
});
for (const id of ['taskName', 'taskPage', 'taskExpected', 'taskSteps']) {
  $(`#${id}`).addEventListener(id === 'taskPage' ? 'change' : 'input', () => {
    if (value('taskId')) $('#taskApproved').checked = false;
  });
}
async function deleteTask(id) {
  const task = config.tasks.find((item) => item.id === id);
  if (!task || !confirm(`Delete task "${task.name}"?`)) return;
  try { config = await api('/api/config', { method: 'PUT', body: JSON.stringify({ ...config, tasks: config.tasks.filter((item) => item.id !== id) }) }); renderTasks(); toast('Task deleted.'); }
  catch (error) { toast(error.message, true); }
}
function setRunning(running) {
  $('#startRun').disabled = running;
  $('#cancelRun').hidden = !running;
  $('#progressArea').hidden = !running;
  $('#runState').textContent = running ? 'Running' : 'Ready';
  $('#runState').classList.toggle('running', running);
}
async function startRun() {
  if (!$('#authorized').checked) return toast('Confirm authorization before starting a run.', true);
  const mode = value('mode');
  const taskId = value('taskPicker');
  const task = config.tasks.find((item) => item.id === taskId);
  if (mode === 'task' && !task) return toast('Choose an approved task spec.', true);
  const selected = $$('.page-select:checked').map((checkbox) => checkbox.value);
  const pageIds = mode === 'task' ? [task.pageId] : selected.length ? selected : config.pages.filter((page) => page.enabled).map((page) => page.id);
  if (!pageIds.length) return toast('Select at least one page to test.', true);
  try {
    const result = await api('/api/runs', { method: 'POST', body: JSON.stringify({ environment: value('environment'), mode, pageIds, taskId, viewports: value('viewports'), accessibility: $('#accessibility').checked, authorized: true }) });
    currentRunId = result.runId;
    currentReport = null;
    $('#resultsSummary').innerHTML = `<p class="empty-state">Run ${esc(result.runId)} started. Test results will appear as pages finish.</p>`;
    $('#resultsList').innerHTML = '';
    $('#downloadJson').disabled = true; $('#downloadCsv').disabled = true;
    setRunning(true); pollRun();
  } catch (error) { toast(error.message, true); }
}
async function pollRun() {
  if (!currentRunId) return;
  try {
    const run = await api(`/api/runs/${encodeURIComponent(currentRunId)}`);
    if (run.status === 'running') {
      $('#progressText').textContent = run.current || 'Running checks';
      $('#progressPercent').textContent = `${run.progress ?? 0}%`;
      $('#progressBar').value = run.progress ?? 0;
      setTimeout(pollRun, 900);
      return;
    }
    if (run.checks) {
      currentReport = run;
      setRunning(false);
      await refreshHistory();
      renderReport(run);
      updateOverview(run);
      $('#downloadJson').disabled = false; $('#downloadCsv').disabled = false;
      toast(`Run complete: ${run.summary.passed} passed, ${run.summary.failed} failed.`);
    } else {
      setRunning(false);
      $('#runState').textContent = run.status || 'Stopped';
      $('#runState').classList.add('error');
      $('#resultsSummary').innerHTML = `<p class="empty-state">Runner could not complete: ${esc(run.error || 'No detailed report was produced. Check the terminal output and browser installation.')}</p>`;
    }
  } catch (error) { setRunning(false); toast(`Could not read run status: ${error.message}`, true); }
}
async function cancelRun() {
  if (!currentRunId) return;
  try { await api(`/api/runs/${encodeURIComponent(currentRunId)}/cancel`, { method: 'POST', body: '{}' }); $('#progressText').textContent = 'Cancellation requested…'; }
  catch (error) { toast(error.message, true); }
}
function renderReport(report) {
  const summary = report.summary;
  $('#runState').textContent = report.status;
  $('#runState').classList.toggle('error', summary.failed > 0);
  $('#resultsSummary').innerHTML = `<div class="panel" style="padding:12px 14px"><div class="result-head"><strong>${esc(report.environment.toUpperCase())} · ${esc(report.mode)} · ${esc(report.viewports.join(' + '))}</strong><small>${dateFormat(report.startedAt)} · ${(report.durationMs / 1000).toFixed(1)} sec</small><strong>${summary.passed} passed · ${summary.failed} failed</strong></div><div class="microcopy">${summary.visualDifferences} visual differences · ${summary.functionalFailures} functional/task failures · ${summary.accessibilityViolations} accessibility scan failures · ${summary.issues} issue records</div><div class="visual-strip"><a href="/api/evidence/${esc(report.runId)}/report.html" target="_blank" rel="noreferrer">Open local HTML report</a></div></div>`;
  $('#resultsList').innerHTML = report.pages.map((page) => {
    const checks = report.checks.filter((check) => check.pageId === page.pageId);
    const issues = page.issues || [];
    const visuals = page.visual || [];
    return `<article class="result-page"><div class="result-head"><strong>${esc(page.pageName)}</strong><small>${esc(shortUrl(page.urls.target))}</small><strong>${checks.filter((check) => check.status === 'passed').length} pass · ${checks.filter((check) => check.status === 'failed').length} fail</strong></div><div class="visual-strip">${Object.entries(page.screenshots || {}).flatMap(([viewport, images]) => [`<a target="_blank" href="${esc(`/api/evidence/${report.runId}/${images.live.replace(`runs/${report.runId}/`, '')}`)}">${esc(viewport)} live screenshot</a>`, `<a target="_blank" href="${esc(`/api/evidence/${report.runId}/${images.target.replace(`runs/${report.runId}/`, '')}`)}">${esc(viewport)} target screenshot</a>`]).join('')}${visuals.map((visual) => `<a target="_blank" href="${esc(`/api/evidence/${report.runId}/${visual.diff.replace(`runs/${report.runId}/`, '')}`)}">${esc(visual.viewport)} ${esc(visual.comparison)} diff (${visual.percent.toFixed(2)}%)</a>`).join('')}</div>${issues.map((issue) => `<section class="issue"><div class="issue-top"><span class="severity ${esc(issue.severity.toLowerCase())}">${esc(issue.severity)}</span><span class="microcopy">${esc(issue.category)} · ${esc(issue.id)} · ${esc(issue.status || 'open')}</span><h3>${esc(issue.title)}</h3></div><p>${esc(issue.summary)}</p><details><summary>Expected vs actual · reproduction · next action</summary><p><b>Expected:</b> ${esc(issue.expected)}</p><p><b>Actual:</b> ${esc(issue.actual)}</p><p><b>URL:</b> ${esc(issue.url)}</p><p><b>Reproduction:</b></p><ol>${(issue.reproductionSteps || []).map((step) => `<li>${esc(step)}</li>`).join('')}</ol><p><b>Next action:</b> ${esc(issue.nextAction)}</p></details><div class="evidence">${(issue.evidence || []).map((link) => `<a href="${esc(link)}" target="_blank" rel="noreferrer">Open evidence</a>`).join('')}</div><div class="issue-controls"><button class="text-button" type="button" data-issue-status="reviewed" data-run="${esc(report.runId)}" data-issue="${esc(issue.id)}">Mark reviewed</button><button class="text-button" type="button" data-issue-status="resolved" data-run="${esc(report.runId)}" data-issue="${esc(issue.id)}">Mark resolved</button></div></section>`).join('')}${checks.length ? `<details class="check-details"><summary class="microcopy">Show all ${checks.length} checks</summary>${checks.map((check) => `<p class="microcopy">${check.status === 'passed' ? 'PASS' : 'FAIL'} · ${esc(check.category)} · ${esc(check.title)} · ${esc(check.actual)}</p>`).join('')}</details>` : ''}${page.screenshots && Object.keys(page.screenshots).length ? Object.keys(page.screenshots).map((viewport) => `<button class="text-button" type="button" data-approve-baseline="${esc(page.pageId)}" data-viewport="${esc(viewport)}" data-run="${esc(report.runId)}">Approve ${esc(viewport)} target as new visual baseline</button>`).join('') : ''}</article>`;
  }).join('');
  $$('.issue', $('#resultsList')).forEach((node) => {
    const issueId = node.querySelector('[data-issue]')?.dataset.issue;
    const issue = report.pages.flatMap((page) => page.issues || []).find((item) => item.id === issueId);
    if (issue?.firstDetectedRun) node.querySelector('.issue-top')?.insertAdjacentHTML('beforeend', `<span class="microcopy">First seen ${esc(issue.firstDetectedRun)} · last seen ${esc(issue.lastDetectedRun)}</span>`);
  });
  report.pages.forEach((page, index) => {
    const card = $$('.result-page', $('#resultsList'))[index];
    const strip = card?.querySelector('.visual-strip');
    if (!strip) return;
    const gallery = Object.entries(page.screenshots || {}).map(([viewport, shots]) => {
      const live = `/api/evidence/${report.runId}/${(shots.liveViewport || shots.live).replace(`runs/${report.runId}/`, '')}`;
      const target = `/api/evidence/${report.runId}/${(shots.targetViewport || shots.target).replace(`runs/${report.runId}/`, '')}`;
      return `<div class="shot-pair"><figure><figcaption>${esc(viewport)} · live reference</figcaption><a href="${esc(live)}" target="_blank"><img src="${esc(live)}" alt="${esc(page.pageName)} live reference at ${esc(viewport)} viewport" loading="lazy"></a></figure><figure><figcaption>${esc(viewport)} · ${esc(report.environment)}</figcaption><a href="${esc(target)}" target="_blank"><img src="${esc(target)}" alt="${esc(page.pageName)} ${esc(report.environment)} at ${esc(viewport)} viewport" loading="lazy"></a></figure></div>`;
    }).join('');
    strip.insertAdjacentHTML('afterend', gallery);
    if (page.figmaUrl) strip.insertAdjacentHTML('afterend', `<div class="visual-strip"><a href="${esc(page.figmaUrl)}" target="_blank" rel="noreferrer">Open configured Figma frame</a></div>`);
  });
  $$('[data-approve-baseline]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Replace the approved visual baseline with this run’s target screenshot? This is a deliberate baseline update.')) return;
    try { const result = await api('/api/baselines/approve', { method: 'POST', body: JSON.stringify({ runId: button.dataset.run, pageId: button.dataset.approveBaseline, viewport: button.dataset.viewport }) }); toast(result.message); }
    catch (error) { toast(error.message, true); }
  }));
  $$('[data-issue-status]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const result = await api(`/api/runs/${encodeURIComponent(button.dataset.run)}/issues/${encodeURIComponent(button.dataset.issue)}`, { method: 'POST', body: JSON.stringify({ status: button.dataset.issueStatus }) });
      const issue = currentReport.pages.flatMap((item) => item.issues || []).find((item) => item.id === button.dataset.issue);
      if (issue) issue.status = result.issue.status;
      renderReport(currentReport);
      toast(`Issue marked ${result.issue.status}.`);
    } catch (error) { toast(error.message, true); }
  }));
}
async function refreshHistory() { history = await api('/api/runs'); renderHistory(); }
function renderHistory() {
  const container = $('#historyList');
  container.innerHTML = history.length ? history.map((item) => `<article class="history-row"><strong class="history-date">${dateFormat(item.startedAt)}</strong><span class="history-meta">${esc(item.environment)} · ${esc(item.mode)}</span><span class="history-meta">${item.passed} pass / ${item.failed} fail</span><span class="history-meta">${item.pageCount} pages · ${Number(item.durationMs / 1000).toFixed(1)}s</span><button class="button" type="button" data-open-run="${esc(item.runId)}">Open report</button></article>`).join('') : '<p class="empty-state">No saved runs. Reports and screenshots are kept locally according to retention settings.</p>';
  $$('[data-open-run]').forEach((button) => button.addEventListener('click', async () => {
    try { const report = await api(`/api/runs/${encodeURIComponent(button.dataset.openRun)}`); if (!report.checks) throw new Error(report.error || 'This run has no detailed report.'); currentRunId = report.runId; currentReport = report; renderReport(report); updateOverview(report); $('#downloadJson').disabled = false; $('#downloadCsv').disabled = false; location.hash = '#results'; }
    catch (error) { toast(error.message, true); }
  }));
}
function download(filename, content, type) {
  const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadReport() {
  if (!currentReport) return;
  download(`qa-report-${currentReport.runId}.json`, JSON.stringify(currentReport, null, 2), 'application/json');
}
function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }
function exportIssues() {
  if (!currentReport) return;
  const rows = [['Issue ID', 'Page', 'Environment', 'Category', 'Title', 'Severity', 'Expected', 'Actual', 'URL', 'Status'], ...currentReport.pages.flatMap((page) => page.issues.map((issue) => [issue.id, issue.pageName, issue.environment, issue.category, issue.title, issue.severity, issue.expected, issue.actual, issue.url, issue.status]))];
  download(`qa-issues-${currentReport.runId}.csv`, rows.map((row) => row.map(csvCell).join(',')).join('\r\n'), 'text/csv');
}
function exportAllJson() { download('gleefull-qa-pages.json', JSON.stringify(config, null, 2), 'application/json'); }
function exportAllCsv() {
  const columns = ['id', 'name', 'enabled', 'liveUrl', 'previewUrl', 'productionUrl', 'figmaUrl', 'expectedTitle', 'expectedHeading', 'ignoreSelectors'];
  const rows = [columns, ...config.pages.map((page) => columns.map((column) => column === 'ignoreSelectors' ? (page[column] || []).join('|') : page[column] ?? ''))];
  download('gleefull-qa-pages.csv', rows.map((row) => row.map(csvCell).join(',')).join('\r\n'), 'text/csv');
}
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') { field += '"'; index++; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && text[index + 1] === '\n') index++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows.filter((item) => item.some((cell) => cell));
  return data.map((cells) => Object.fromEntries(header.map((name, index) => [name.trim(), cells[index] ?? '']))).map((page) => ({ ...page, enabled: !(page.enabled === false || page.enabled === 'false'), ignoreSelectors: (page.ignoreSelectors || '').split('|').map((item) => item.trim()).filter(Boolean) }));
}
$('#importFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    const text = await file.text();
    const imported = file.name.toLowerCase().endsWith('.csv') ? parseCsv(text) : JSON.parse(text);
    const pages = Array.isArray(imported) ? imported : imported.pages;
    if (!Array.isArray(pages)) throw new Error('Expected a JSON object with a pages array or CSV page rows.');
    if (!confirm(`Replace the current ${config.pages.length} saved pages with ${pages.length} imported pages?`)) return;
    const remainingTasks = config.tasks.filter((task) => pages.some((page) => page.id === task.pageId));
    config = await api('/api/config', { method: 'PUT', body: JSON.stringify({ ...config, pages, tasks: remainingTasks }) });
    selectedIds.clear(); config.pages.filter((page) => page.enabled).forEach((page) => selectedIds.add(page.id));
    renderPages(); renderTasks(); toast(`${pages.length} pages imported.`);
  } catch (error) { toast(`Import failed: ${error.message}`, true); }
  finally { event.target.value = ''; }
});

$('#saveConfig').addEventListener('click', saveConfig);
$('#addPage').addEventListener('click', () => editPage());
$('#addTask').addEventListener('click', () => editTask());
$('#startRun').addEventListener('click', startRun);
$('#cancelRun').addEventListener('click', cancelRun);
$('#downloadJson').addEventListener('click', downloadReport);
$('#downloadCsv').addEventListener('click', exportIssues);
$('#exportJson').addEventListener('click', exportAllJson);
$('#exportCsv').addEventListener('click', exportAllCsv);
$('#selectAllPages').addEventListener('change', () => {
  selectedIds.clear();
  if ($('#selectAllPages').checked) config.pages.filter((page) => page.enabled).forEach((page) => selectedIds.add(page.id));
  renderPages();
});
$('#mode').addEventListener('change', () => {
  const mode = value('mode');
  const taskMode = mode === 'task';
  const descriptions = {
    full: 'Full regression checks page health, internal links, responsive layout, and live-reference visual differences.',
    ui: 'UI-only checks page structure, media, responsive layout, and live-reference screenshots.',
    functional: 'Functional-only checks page health, internal links, and configured expectations without pixel comparisons.',
    task: 'Runs only the selected, approved task specification on its configured Preview page.',
  };
  $('#runHint').textContent = descriptions[mode];
  $('#taskPickerLabel').hidden = !taskMode;
  $('#environment').value = taskMode ? 'preview' : $('#environment').value;
  $('#environment').disabled = taskMode;
});
$('#environment').addEventListener('change', async () => {
  config.targetEnvironment = value('environment');
  try { config = await api('/api/config', { method: 'PUT', body: JSON.stringify(config) }); }
  catch (error) { toast(error.message, true); }
});
$('#loadDemo').addEventListener('click', async () => {
  try { const result = await api('/api/demo', { method: 'POST', body: '{}' }); config = result.config; selectedIds.clear(); selectedIds.add('demo-store-page'); renderConfig(); renderPages(); renderTasks(); renderHistory(); toast('Local demo ready: run Full Regression for a visual difference, then run its task spec to see a controlled failure.'); }
  catch (error) { toast(error.message, true); }
});
$$('[data-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
$$('.nav-link').forEach((link) => link.addEventListener('click', () => { $$('.nav-link').forEach((item) => item.classList.remove('active')); link.classList.add('active'); }));
load();
