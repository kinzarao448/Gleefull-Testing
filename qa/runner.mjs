import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { buildIssue, validateTaskStep } from './lib.mjs';

const inputFile = path.resolve(process.argv[2] || '');
const input = JSON.parse(await fs.readFile(inputFile, 'utf8'));
const dataDir = path.resolve(path.dirname(inputFile), '..', '..');
const runDir = path.dirname(inputFile);
const artifactDir = path.join(runDir, 'artifacts');
const statusFile = path.join(runDir, 'status.json');
const started = Date.now();
const checks = [];
const pageReports = [];
let cancelled = false;
let browser = null;

process.on('SIGTERM', () => {
  cancelled = true;
  browser?.close().catch(() => {});
});
const writeStatus = async (status) => {
  const temporaryFile = `${statusFile}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(status, null, 2));
  await fs.rename(temporaryFile, statusFile);
};
const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'page';
const evidencePath = (filename) => `runs/${input.runId}/artifacts/${filename}`;
const evidenceUrl = (runId, filename) => `/api/evidence/${runId}/artifacts/${filename}`;
const viewportSize = { desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } };

function addCheck(page, category, title, passed, actual, expected, evidence = []) {
  const record = { id: `T${String(checks.length + 1).padStart(3, '0')}`, pageId: page.id, pageName: page.name, category, title, status: passed ? 'passed' : 'failed', expected, actual: String(actual || ''), evidence, durationMs: 0 };
  checks.push(record);
  return record;
}
function addIssue(page, environment, category, title, summary, expected, actual, severity, evidence = [], steps = []) {
  const issue = buildIssue({ page, environment, category, title, summary, expected, actual, severity, evidence, steps });
  return issue;
}
async function updateScreenshotStable(page) {
  await page.locator('body').waitFor({ state: 'visible', timeout: 12_000 });
  await page.evaluate(async () => {
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const fonts = document.fonts?.ready || Promise.resolve();
    const loadedImages = [...document.images].filter((image) => image.complete || image.loading !== 'lazy');
    const images = loadedImages.map((image) => Promise.race([image.decode().catch(() => {}), delay(1_800)]));
    await Promise.race([Promise.all([Promise.race([fonts, delay(2_000)]), ...images]), delay(5_000)]);
  });
}
async function capture(page, filename, ignoreSelectors = []) {
  const masks = [];
  for (const selector of ignoreSelectors) {
    try { const locator = page.locator(selector); if (await locator.count()) masks.push(locator); } catch { /* Ignore invalid optional mask selectors. */ }
  }
  await updateScreenshotStable(page);
  const fullPath = path.join(artifactDir, filename);
  const viewportPath = path.join(artifactDir, filename.replace(/\.png$/, '-viewport.png'));
  await page.screenshot({ path: fullPath, fullPage: true, animations: 'disabled', caret: 'hide', mask: masks, maskColor: '#ff00ff' });
  await page.screenshot({ path: viewportPath, animations: 'disabled', caret: 'hide', mask: masks, maskColor: '#ff00ff' });
  return { full: fullPath, viewport: viewportPath };
}
async function attachFailureEvidence(page, pageConfig, viewport, issue) {
  try {
    const files = await capture(page, `${slug(pageConfig.name)}-${viewport}-reference-failure.png`, pageConfig.ignoreSelectors);
    issue.evidence.push(evidenceUrl(input.runId, path.basename(files.viewport)));
    issue.evidence.push(evidenceUrl(input.runId, path.basename(files.full)));
  } catch { /* Keep the issue even if the browser cannot capture a failure screenshot. */ }
}
async function compareImages(referenceFile, targetFile, diffFile) {
  const reference = PNG.sync.read(await fs.readFile(referenceFile));
  const target = PNG.sync.read(await fs.readFile(targetFile));
  const width = Math.max(reference.width, target.width);
  const height = Math.max(reference.height, target.height);
  const left = new PNG({ width, height, fillColor: { color: 0xffffff, alpha: 1 } });
  const right = new PNG({ width, height, fillColor: { color: 0xffffff, alpha: 1 } });
  PNG.bitblt(reference, left, 0, 0, reference.width, reference.height, 0, 0);
  PNG.bitblt(target, right, 0, 0, target.width, target.height, 0, 0);
  const diff = new PNG({ width, height });
  const changedPixels = pixelmatch(left.data, right.data, diff.data, width, height, { threshold: 0.12, includeAA: false, diffColor: [222, 68, 54], alpha: 0.55 });
  await fs.writeFile(diffFile, PNG.sync.write(diff));
  return { percent: changedPixels * 100 / (width * height), changedPixels, width, height, sizeChanged: reference.width !== target.width || reference.height !== target.height };
}
async function applyTask(page, task) {
  for (const step of task.steps) {
    validateTaskStep(step);
    if (step.action === 'clickRole') await page.getByRole(step.value, { name: step.name || undefined }).click();
    else if (step.action === 'clickText') await page.getByText(step.value, { exact: step.exact === true }).click();
    else if (step.action === 'fillLabel') await page.getByLabel(step.value).fill(step.input);
    else if (step.action === 'expectText') await page.getByText(step.value, { exact: step.exact === true }).first().waitFor({ state: 'visible' });
    else if (step.action === 'expectUrl') await page.waitForURL(new RegExp(step.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
}
async function checkInternalLinks(page, pageConfig, environment, report, onProgress = () => {}) {
  const base = page.url();
  const links = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) => ({ href: anchor.href, name: (anchor.innerText || anchor.getAttribute('aria-label') || '').trim().slice(0, 100) })));
  const ignored = /\/checkout|\/cart\/add|\/account\/logout|\/challenge|\/apps\/track/i;
  const unique = [...new Map(links.filter((link) => {
    try { const url = new URL(link.href); return url.origin === new URL(base).origin && url.protocol.startsWith('http') && !ignored.test(url.pathname); } catch { return false; }
  }).map((link) => [link.href, link])).values()].slice(0, 40);
  const failures = [];
  const batchSize = 6;
  for (let offset = 0; offset < unique.length; offset += batchSize) {
    const batch = unique.slice(offset, offset + batchSize);
    const outcomes = await Promise.all(batch.map(async (link) => {
      try {
        const response = await page.request.get(link.href, { timeout: 5_000, maxRedirects: 3 });
        return response.status() === 404 || response.status() >= 500 ? `${response.status()} ${link.href}${link.name ? ` (${link.name})` : ''}` : '';
      } catch (error) { return `${error.message.split('\n')[0]} ${link.href}`; }
    }));
    failures.push(...outcomes.filter(Boolean));
    await onProgress(Math.min(offset + batch.length, unique.length), unique.length);
  }
  const record = addCheck(pageConfig, 'functional', 'Internal navigation destinations', failures.length === 0, failures.length ? failures.join('; ') : `${unique.length} internal destinations responded successfully or with an expected restricted status.`, 'Internal content links should not return 404 or 5xx.', []);
  if (!record.status || failures.length) report.issues.push(addIssue(pageConfig, environment, 'functional', 'Broken internal destination', 'One or more same-origin page links could not be reached or returned an unexpected server error.', 'Linked content pages return successfully.', failures.join('\n'), 'Medium', [], ['Open the page URL.', 'Follow the listed internal link.', 'Confirm whether the destination should exist.']));
}

async function runPage(browser, pageConfig, index) {
  const report = { pageId: pageConfig.id, pageName: pageConfig.name, figmaUrl: pageConfig.figmaUrl, urls: { live: pageConfig.liveUrl, target: pageConfig[`${input.environment}Url`] }, screenshots: {}, visual: [], issues: [], skipped: [], accessibilityViolationCount: 0 };
  const targetUrl = pageConfig[`${input.environment}Url`];
  const runVisual = input.mode === 'full' || input.mode === 'ui';
  const runFunctional = input.mode === 'full' || input.mode === 'functional';
  const runTask = input.mode === 'task' && pageConfig.id === input.task.pageId;

  for (const viewport of input.viewports) {
    if (cancelled) break;
    await writeStatus({ runId: input.runId, status: 'running', current: `${pageConfig.name} · ${viewport}: loading page`, progress: Math.round(index / input.pages.length * 100), completedPages: index, totalPages: input.pages.length });
    const context = await browser.newContext({ viewport: viewportSize[viewport], deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'light' });
    const target = await context.newPage();
    target.setDefaultTimeout(5_000);
    const runtimeErrors = [];
    target.on('pageerror', (error) => runtimeErrors.push(`Uncaught page error: ${error.message}`));
    target.on('console', (message) => { if (message.type() === 'error') runtimeErrors.push(`Console error: ${message.text()}`); });
    target.on('response', (response) => {
      try { if (response.status() >= 500 && new URL(response.url()).origin === new URL(targetUrl).origin) runtimeErrors.push(`HTTP ${response.status()}: ${response.url()}`); } catch { /* Ignore non-URL response entries. */ }
    });
    let targetResponse;
    try {
      targetResponse = await target.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35_000 });
    } catch (error) {
      const actual = error.message.split('\n')[0];
      const issue = addIssue(pageConfig, input.environment, 'network/runtime', 'Target page unavailable', 'The configured target page could not be opened.', 'Page responds and renders.', actual, 'High', [], [`Navigate to ${targetUrl}`, 'Check preview access and deployment health.']);
      await attachFailureEvidence(target, pageConfig, viewport, issue);
      addCheck(pageConfig, 'network/runtime', `${viewport} target page loads`, false, actual, 'Page responds and renders within the configured timeout.', issue.evidence);
      report.issues.push(issue);
      await context.close();
      continue;
    }
    const statusOk = targetResponse && targetResponse.status() < 400;
    addCheck(pageConfig, 'functional', `${viewport} target page loads`, statusOk, `HTTP ${targetResponse?.status() ?? 'no response'}`, 'HTTP response below 400.');
    if (!statusOk) report.issues.push(addIssue(pageConfig, input.environment, 'network/runtime', 'Unexpected target response', 'The configured page returned an HTTP error response.', 'HTTP response below 400.', `HTTP ${targetResponse?.status() ?? 'no response'}`, targetResponse?.status() >= 500 ? 'High' : 'Medium'));

    const navigationMs = await target.evaluate(() => Math.round(performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd || 0));
    addCheck(pageConfig, 'performance', `${viewport} DOM ready time`, navigationMs <= 15_000, `${navigationMs} ms`, 'DOM content becomes available within 15 seconds.');
    if (navigationMs > 15_000) report.issues.push(addIssue(pageConfig, input.environment, 'performance', 'Slow initial page load', 'The page took more than 15 seconds to reach DOMContentLoaded.', 'DOM content becomes available within 15 seconds.', `${navigationMs} ms`, 'Medium', [], [`Open ${targetUrl}`, 'Review server response time and blocking resources.']));

    const title = await target.title().catch(() => '');
    const heading = (await target.locator('h1').first().innerText().catch(() => '')).trim();
    const structureOk = await target.locator('main').count().then((count) => count > 0).catch(() => false) && Boolean(heading);
    addCheck(pageConfig, 'functional', `${viewport} primary content is present`, structureOk, `title="${title}"; h1="${heading}"`, 'A main region and visible primary heading are present.');
    if (!structureOk) report.issues.push(addIssue(pageConfig, input.environment, 'functional', 'Primary content missing', 'A main landmark or primary heading was not found.', 'A main landmark and primary heading are visible.', `title="${title}"; h1="${heading}"`, 'High'));
    if (pageConfig.expectedTitle) {
      const titleOk = title.includes(pageConfig.expectedTitle);
      addCheck(pageConfig, 'functional', 'Configured page title', titleOk, title, `Title includes "${pageConfig.expectedTitle}".`);
      if (!titleOk) report.issues.push(addIssue(pageConfig, input.environment, 'functional', 'Page title differs from expectation', 'The configured expected title was not found.', `Title includes "${pageConfig.expectedTitle}".`, title, 'Low'));
    }
    if (pageConfig.expectedHeading) {
      const headingOk = heading.includes(pageConfig.expectedHeading);
      addCheck(pageConfig, 'functional', 'Configured primary heading', headingOk, heading, `H1 includes "${pageConfig.expectedHeading}".`);
      if (!headingOk) report.issues.push(addIssue(pageConfig, input.environment, 'functional', 'Primary heading differs from expectation', 'The configured expected heading was not found.', `H1 includes "${pageConfig.expectedHeading}".`, heading, 'Medium'));
    }

    if (runFunctional) {
      if (viewport === input.viewports[0]) await checkInternalLinks(target, pageConfig, input.environment, report, async (checked, total) => {
        const fraction = total ? checked / total : 1;
        const progress = Math.round(((index + fraction * 0.4) / input.pages.length) * 100);
        await writeStatus({ runId: input.runId, status: 'running', current: `${pageConfig.name} · checked ${checked}/${total} internal links`, progress, completedPages: index, totalPages: input.pages.length });
      });
      const controlSummary = await target.locator('a[href],button').evaluateAll((elements) => ({
        count: elements.length,
        unnamed: elements.filter((element) => !(element.innerText || element.getAttribute('aria-label') || element.getAttribute('title') || '').trim()).length,
      }));
      addCheck(pageConfig, 'functional', 'Links and buttons are named', controlSummary.unnamed === 0, `${controlSummary.count} controls checked; ${controlSummary.unnamed} have no accessible name.`, 'Links and buttons have visible or accessible names.');
      if (controlSummary.unnamed) report.issues.push(addIssue(pageConfig, input.environment, 'functional', 'Unnamed link or button', `${controlSummary.unnamed} interactive controls do not expose a readable name.`, 'Links and buttons have an accessible name.', `${controlSummary.unnamed} unnamed controls among ${controlSummary.count}.`, 'Medium'));

      const expandableButtons = target.locator('button[aria-expanded][type="button"]');
      const expandableCount = await expandableButtons.count();
      const interactionFailures = [];
      for (let index = 0; index < expandableCount; index++) {
        const button = expandableButtons.nth(index);
        const before = await button.getAttribute('aria-expanded');
        if (!before || await button.isDisabled()) continue;
        try {
          await button.click();
          const opened = await button.getAttribute('aria-expanded');
          if (opened === before) throw new Error('aria-expanded did not change after activation.');
          await button.click();
          if (await button.getAttribute('aria-expanded') !== before) throw new Error('aria-expanded did not return to its original state.');
        } catch (error) {
          interactionFailures.push(`${(await button.innerText().catch(() => 'Expandable button')).trim()}: ${error.message.split('\n')[0]}`);
        }
      }
      addCheck(pageConfig, 'functional', 'Safe expandable button interactions', interactionFailures.length === 0, expandableCount ? interactionFailures.join('; ') || `${expandableCount} expandable button(s) opened and restored.` : 'No aria-expanded buttons found; interaction check skipped.', 'Non-submit disclosure/menu buttons toggle their expanded state and can be restored.');
      if (interactionFailures.length) report.issues.push(addIssue(pageConfig, input.environment, 'functional', 'Expandable button interaction failed', 'A disclosure or menu button did not toggle its advertised expanded state.', 'Clicking the control changes aria-expanded and can return to its initial state.', interactionFailures.join('\n'), 'Medium'));

      const formSummary = await target.locator('form').evaluateAll((forms) => {
        const required = forms.flatMap((form) => [...form.querySelectorAll('input[required],select[required],textarea[required]')]);
        const unnamedRequired = required.filter((control) => !control.labels?.length && !control.getAttribute('aria-label')).length;
        const emptyRequired = required.some((control) => !String(control.value || '').trim());
        return { forms: forms.length, required: required.length, unnamedRequired, emptyRequired, invalidWhenRequiredEmpty: forms.filter((form) => [...form.querySelectorAll('input[required],select[required],textarea[required]')].some((control) => !String(control.value || '').trim())).every((form) => !form.checkValidity()) };
      });
      const formsValid = formSummary.unnamedRequired === 0 && (!formSummary.emptyRequired || formSummary.invalidWhenRequiredEmpty);
      addCheck(pageConfig, 'functional', 'Forms expose safe required-field validation', formsValid, formSummary.forms ? `${formSummary.forms} forms; ${formSummary.required} required fields; ${formSummary.unnamedRequired} required fields without labels.` : 'No forms found; form validation check skipped.', 'Required form fields are labeled and browser validity rejects empty required values.');
      if (!formsValid) report.issues.push(addIssue(pageConfig, input.environment, 'functional', 'Form validation or labels missing', 'A required form field is unnamed or an empty required form passes browser validity.', 'Required fields are labeled and empty required values fail validity checks.', `${formSummary.unnamedRequired} unnamed required fields; empty required values rejected: ${formSummary.invalidWhenRequiredEmpty}.`, 'Medium'));
    }

    if (runTask) {
      try {
        await applyTask(target, input.task);
        addCheck(pageConfig, 'task-specific', input.task.name, true, 'Every configured action and expectation passed.', input.task.expectedResult);
      } catch (error) {
        const actual = error.message.split('\n')[0];
        addCheck(pageConfig, 'task-specific', input.task.name, false, actual, input.task.expectedResult);
        report.issues.push(addIssue(pageConfig, input.environment, 'task-specific', input.task.name, 'A reviewed task step did not match its expected result.', input.task.expectedResult, actual, 'Medium', [], input.task.steps.map((step) => `${step.action}: ${step.value}`)));
      }
    }

    const brokenImages = await target.locator('main img').evaluateAll((images) => images.filter((image) => image.complete && image.naturalWidth === 0).map((image) => image.currentSrc || image.src));
    addCheck(pageConfig, 'ui', 'Main content images load', brokenImages.length === 0, brokenImages.join('\n') || 'No broken loaded images found.', 'Images in main content have non-zero natural dimensions.');
    if (brokenImages.length) report.issues.push(addIssue(pageConfig, input.environment, 'ui', 'Broken content image', 'One or more main-content images failed to load.', 'Content images load.', brokenImages.join('\n'), 'Medium'));

    if (input.accessibility) {
      try {
        const axe = await new AxeBuilder({ page: target }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        report.accessibilityViolationCount += axe.violations.length;
        addCheck(pageConfig, 'accessibility', `${viewport} axe scan`, axe.violations.length === 0, `${axe.violations.length} violation group(s) found.`, 'No automated axe WCAG 2.1 A/AA violations detected.');
        for (const violation of axe.violations) {
          const affected = violation.nodes.map((node) => `${node.target.join(', ')}: ${node.failureSummary || node.html}`).slice(0, 8);
          report.issues.push(addIssue(pageConfig, input.environment, 'accessibility', `${violation.impact || 'moderate'}: ${violation.help}`, violation.description, violation.help, affected.join('\n'), violation.impact === 'critical' ? 'High' : 'Medium', [], []));
        }
      } catch (error) { addCheck(pageConfig, 'accessibility', `${viewport} axe scan`, false, error.message, 'Axe scan completes.'); }
    }

    if (runtimeErrors.length) {
      addCheck(pageConfig, 'network/runtime', `${viewport} browser and first-party runtime`, false, runtimeErrors.join('\n'), 'No uncaught page exceptions, console errors, or first-party 5xx responses.');
      report.issues.push(addIssue(pageConfig, input.environment, 'network/runtime', 'Browser or first-party server errors', 'Runtime errors or first-party 5xx responses were observed during page load.', 'No unexpected browser or first-party server errors.', runtimeErrors.join('\n'), 'High'));
    } else addCheck(pageConfig, 'network/runtime', `${viewport} browser and first-party runtime`, true, 'No captured first-party runtime errors.', 'No uncaught page exceptions, console errors, or first-party 5xx responses.');

    if (runVisual && pageConfig.liveUrl) {
      const reference = await context.newPage();
      try {
        const response = await reference.goto(pageConfig.liveUrl, { waitUntil: 'domcontentloaded', timeout: 35_000 });
        if (!response || response.status() >= 400) throw new Error(`Reference returned HTTP ${response?.status() ?? 'no response'}.`);
        const liveTitle = await reference.title().catch(() => '');
        const liveHeading = (await reference.locator('h1').first().innerText().catch(() => '')).trim();
        const key = `${slug(pageConfig.name)}-${viewport}`;
        const targetFiles = await capture(target, `${key}-target.png`, pageConfig.ignoreSelectors);
        const referenceFiles = await capture(reference, `${key}-live.png`, pageConfig.ignoreSelectors);
        const targetFile = targetFiles.full;
        const referenceFile = referenceFiles.full;
        report.screenshots[viewport] = {
          target: evidencePath(path.basename(targetFiles.full)),
          live: evidencePath(path.basename(referenceFiles.full)),
          targetViewport: evidencePath(path.basename(targetFiles.viewport)),
          liveViewport: evidencePath(path.basename(referenceFiles.viewport)),
        };
        const diffFile = path.join(artifactDir, `${key}-live-diff.png`);
        const comparison = await compareImages(referenceFile, targetFile, diffFile);
        const threshold = input.config.visualThreshold;
        report.visual.push({ viewport, comparison: 'live-reference', ...comparison, threshold, diff: evidencePath(path.basename(diffFile)) });
        const withinLimit = comparison.percent <= threshold && !comparison.sizeChanged;
        addCheck(pageConfig, 'ui', `${viewport} preview vs live visual comparison`, withinLimit, `${comparison.percent.toFixed(3)}% changed pixels${comparison.sizeChanged ? '; image dimensions differ' : ''}.`, `At most ${threshold}% changed pixels; matching screenshot dimensions.`, [evidenceUrl(input.runId, path.basename(diffFile))]);
        if (!withinLimit) report.issues.push(addIssue(pageConfig, input.environment, 'ui', `${viewport} potential visual regression`, 'A pixel-level difference was observed. Review it against the Figma design because live content may change independently.', `Difference at or below ${threshold}% and matching dimensions, or documented intentional differences.`, `${comparison.percent.toFixed(3)}% changed pixels; ${comparison.changedPixels} pixels differ${comparison.sizeChanged ? `; reference ${comparison.width}x${comparison.height} and target dimensions differ` : ''}.`, 'Medium', [evidenceUrl(input.runId, path.basename(targetFile)), evidenceUrl(input.runId, path.basename(referenceFile)), evidenceUrl(input.runId, path.basename(diffFile))], ['Open the live and target screenshots at the same viewport.', 'Compare the changed page with its Figma frame.', 'Mark intentional content differences or fix the visual regression.']));

        const liveTargetMatch = liveTitle === title && liveHeading === heading;
        addCheck(pageConfig, 'functional', `${viewport} live vs target title and H1`, liveTargetMatch, `Live title="${liveTitle}"; H1="${liveHeading}". Target title="${title}"; H1="${heading}".`, 'Title and primary heading match Live, or the changed content is reviewed as intentional.', [evidenceUrl(input.runId, path.basename(referenceFiles.viewport)), evidenceUrl(input.runId, path.basename(targetFiles.viewport))]);
        if (!liveTargetMatch) {
          report.issues.push(addIssue(pageConfig, input.environment, 'functional', `${viewport} Live/target title or heading differs`, 'The page title or primary heading differs from Live. This is an observed difference and may be intentional for the release.', 'Title and H1 match Live unless the content change is part of the approved task.', `Live title="${liveTitle}"; H1="${liveHeading}". Target title="${title}"; H1="${heading}".`, 'Medium', [evidenceUrl(input.runId, path.basename(referenceFiles.viewport)), evidenceUrl(input.runId, path.basename(targetFiles.viewport))], ['Review the changed page requirement.', 'Compare the target copy with the approved Figma/content brief.', 'Record whether the difference is intentional.']));
        }

        const baselineFile = path.join(dataDir, 'baselines', `${pageConfig.id}-${viewport}.png`);
        try {
          await fs.access(baselineFile);
          const baselineDiff = path.join(artifactDir, `${key}-approved-diff.png`);
          const baselineComparison = await compareImages(baselineFile, targetFile, baselineDiff);
          report.visual.push({ viewport, comparison: 'approved-baseline', ...baselineComparison, threshold, diff: evidencePath(path.basename(baselineDiff)) });
          if (baselineComparison.percent > threshold || baselineComparison.sizeChanged) {
            report.issues.push(addIssue(pageConfig, input.environment, 'ui', `${viewport} differs from approved baseline`, 'The target page differs from a baseline explicitly approved in an earlier run.', `At most ${threshold}% changed pixels and matching screenshot dimensions.`, `${baselineComparison.percent.toFixed(3)}% changed pixels.`, 'Medium', [evidenceUrl(input.runId, path.basename(targetFile)), evidenceUrl(input.runId, path.basename(baselineDiff))]));
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      } catch (error) {
        const actual = error.message.split('\n')[0];
        report.skipped.push(`${viewport} visual comparison failed: ${actual}`);
        const issue = addIssue(pageConfig, input.environment, 'ui', `${viewport} live reference comparison unavailable`, 'The configured Live/reference page could not be captured, so pixel comparison did not complete.', 'The Live/reference page opens and a comparable screenshot diff is generated.', actual, 'High', [], [`Open reference URL: ${pageConfig.liveUrl}`, 'Confirm reference access and browser rendering.', 'Rerun the comparison.']);
        await attachFailureEvidence(target, pageConfig, viewport, issue);
        addCheck(pageConfig, 'ui', `${viewport} live reference comparison`, false, actual, 'Live reference loads and produces a screenshot comparison.', issue.evidence);
        report.issues.push(issue);
      } finally { await reference.close(); }
    } else if (runVisual) {
      const actual = 'No Live/reference URL is configured for this page.';
      report.skipped.push(`Visual comparison failed: ${actual}`);
      const issue = addIssue(pageConfig, input.environment, 'ui', 'Live reference URL missing', 'The visual comparison was not run because this page has no reference URL.', 'A Live/reference URL is configured for the page.', actual, 'High', [], ['Edit this page record.', 'Add its exact Live/reference URL.', 'Rerun the visual comparison.']);
      await attachFailureEvidence(target, pageConfig, viewport, issue);
      addCheck(pageConfig, 'ui', `${viewport} live reference comparison`, false, actual, 'Live reference URL is configured and produces a screenshot comparison.', issue.evidence);
      report.issues.push(issue);
    }

    const horizontal = await target.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    const fits = horizontal.content <= horizontal.viewport + 1;
    addCheck(pageConfig, 'ui', `${viewport} horizontal overflow`, fits, `${horizontal.content}px content in ${horizontal.viewport}px viewport.`, 'Page content does not overflow horizontally.');
    if (!fits) report.issues.push(addIssue(pageConfig, input.environment, 'ui', `${viewport} horizontal overflow`, 'The document is wider than the viewport and may clip content.', 'Content width fits the viewport.', `${horizontal.content}px content; ${horizontal.viewport}px viewport.`, 'Medium'));

    const issuesWithoutEvidence = report.issues.filter((issue) => issue.evidence.length === 0);
    if (issuesWithoutEvidence.length) {
      const failureFiles = await capture(target, `${slug(pageConfig.name)}-${viewport}-failure.png`, pageConfig.ignoreSelectors);
      report.failureScreenshots ||= {};
      report.failureScreenshots[viewport] = { full: evidencePath(path.basename(failureFiles.full)), viewport: evidencePath(path.basename(failureFiles.viewport)) };
      for (const issue of issuesWithoutEvidence) {
        issue.evidence.push(evidenceUrl(input.runId, path.basename(failureFiles.viewport)));
        issue.evidence.push(evidenceUrl(input.runId, path.basename(failureFiles.full)));
      }
    }

    await context.close();
    await writeStatus({ runId: input.runId, status: 'running', current: pageConfig.name, progress: Math.round(((index + 1) / input.pages.length) * 100), completedPages: index + 1, totalPages: input.pages.length });
  }
  pageReports.push(report);
}

try {
  browser = await chromium.launch({ headless: true });
  for (const [index, page] of input.pages.entries()) {
    if (cancelled) break;
    await writeStatus({ runId: input.runId, status: 'running', current: page.name, progress: Math.round((index / input.pages.length) * 100), completedPages: index, totalPages: input.pages.length });
    await runPage(browser, page, index);
  }
} catch (error) {
  if (cancelled) {
    await writeStatus({ runId: input.runId, status: 'cancelled', current: 'Cancelled', progress: 0 });
  } else {
    await writeStatus({ runId: input.runId, status: 'infrastructure-error', current: 'Browser setup', error: error.stack || error.message, progress: 0 });
    process.exitCode = 1;
  }
} finally {
  await browser?.close().catch(() => {});
}

const summary = {
  pages: pageReports.length,
  passed: checks.filter((check) => check.status === 'passed').length,
  failed: checks.filter((check) => check.status === 'failed').length,
  issues: pageReports.reduce((total, page) => total + page.issues.length, 0),
  visualDifferences: pageReports.reduce((total, page) => total + page.visual.filter((item) => item.comparison === 'live-reference' && (item.percent > item.threshold || item.sizeChanged)).length, 0),
  functionalFailures: checks.filter((check) => check.status === 'failed' && ['functional', 'task-specific'].includes(check.category)).length,
  accessibilityViolations: pageReports.reduce((total, page) => total + page.accessibilityViolationCount, 0),
};
const report = { runId: input.runId, status: cancelled ? 'cancelled' : process.exitCode ? 'infrastructure-error' : 'completed', environment: input.environment, mode: input.mode, viewports: input.viewports, startedAt: input.startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started, pages: pageReports, checks, summary };
await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
const htmlEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const reportIssues = pageReports.flatMap((page) => page.issues.map((issue) => `<article><h3>${htmlEscape(issue.title)} <small>${htmlEscape(issue.severity)} · ${htmlEscape(issue.category)}</small></h3><p>${htmlEscape(issue.summary)}</p><p><b>Expected:</b> ${htmlEscape(issue.expected)}</p><p><b>Actual:</b> ${htmlEscape(issue.actual)}</p><p><b>URL:</b> ${htmlEscape(issue.url)}</p><p><b>Next:</b> ${htmlEscape(issue.nextAction)}</p>${issue.evidence.map((item) => `<a href="${htmlEscape(item.replace(`runs/${input.runId}/`, ''))}">Open evidence</a>`).join(' · ')}</article>`)).join('');
const reportChecks = checks.map((check) => `<tr><td>${htmlEscape(check.status.toUpperCase())}</td><td>${htmlEscape(check.pageName)}</td><td>${htmlEscape(check.category)}</td><td>${htmlEscape(check.title)}</td><td><pre>${htmlEscape(check.actual)}</pre></td></tr>`).join('');
const reportPages = pageReports.map((page) => `<section><h2>${htmlEscape(page.pageName)}</h2><p>${htmlEscape(page.urls.target)}</p>${Object.entries(page.screenshots).map(([viewport, shots]) => `<p>${htmlEscape(viewport)}: <a href="${htmlEscape(shots.live.replace(`runs/${input.runId}/`, ''))}">Live screenshot</a> · <a href="${htmlEscape(shots.target.replace(`runs/${input.runId}/`, ''))}">Target screenshot</a></p>`).join('')}</section>`).join('');
const reportHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QA report ${htmlEscape(input.runId)}</title><style>body{max-width:1100px;margin:34px auto;padding:0 18px;color:#1d2924;background:#f1f4ef;font:14px system-ui,sans-serif}h1,h2{color:#174c39}h1{font-size:28px}section,article{margin:12px 0;padding:14px;background:#fff;border:1px solid #dbe2dc}small{color:#a24632;font-weight:600}a{color:#174c39}table{width:100%;border-collapse:collapse;background:#fff;font-size:12px}th,td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid #e1e8e1}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}.summary{display:flex;gap:18px;flex-wrap:wrap}.summary b{color:#174c39}</style></head><body><h1>Storefront QA report</h1><p>${htmlEscape(input.environment)} · ${htmlEscape(input.mode)} · ${htmlEscape(input.viewports.join(' + '))} · ${htmlEscape(report.startedAt)} · ${(report.durationMs / 1000).toFixed(1)} seconds</p><div class="summary"><b>${summary.pages} pages</b><b>${summary.passed} passed</b><b>${summary.failed} failed</b><b>${summary.visualDifferences} visual differences</b><b>${summary.issues} issues</b></div><h2>Pages and evidence</h2>${reportPages}<h2>Issue details</h2>${reportIssues || '<p>No issue records.</p>'}<h2>Checks</h2><table><thead><tr><th>Status</th><th>Page</th><th>Category</th><th>Check</th><th>Actual</th></tr></thead><tbody>${reportChecks}</tbody></table><p>Automated differences are potential issues, not confirmed defects. Compare with the approved design and review dynamic live content.</p></body></html>`;
await fs.writeFile(path.join(runDir, 'report.html'), reportHtml);
await writeStatus({ runId: input.runId, status: report.status, current: cancelled ? 'Cancelled' : 'Complete', progress: cancelled ? undefined : 100, summary });
