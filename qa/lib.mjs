import { createHash, randomUUID } from 'node:crypto';

export const defaultConfig = {
  targetEnvironment: 'preview',
  liveBaseUrl: 'https://gleefullsupps.com',
  previewBaseUrl: '',
  productionBaseUrl: '',
  visualThreshold: 0.5,
  historyRetention: 30,
  pages: [],
  tasks: [],
};

export function normalizeConfig(value = {}) {
  const config = { ...defaultConfig, ...value };
  config.liveBaseUrl = validOptionalUrl(config.liveBaseUrl, 'Live base URL');
  config.previewBaseUrl = validOptionalUrl(config.previewBaseUrl, 'Preview base URL');
  config.productionBaseUrl = validOptionalUrl(config.productionBaseUrl, 'Production base URL');
  if (!['preview', 'production'].includes(config.targetEnvironment)) {
    throw new Error('Choose Preview or Production as the target environment.');
  }
  config.visualThreshold = Number(config.visualThreshold);
  config.historyRetention = Number(config.historyRetention);
  if (!Number.isFinite(config.visualThreshold) || config.visualThreshold < 0 || config.visualThreshold > 100) {
    throw new Error('Visual threshold must be a number from 0 to 100 percent.');
  }
  if (!Number.isInteger(config.historyRetention) || config.historyRetention < 1 || config.historyRetention > 365) {
    throw new Error('History retention must be between 1 and 365 runs.');
  }
  if (!Array.isArray(config.pages) || !Array.isArray(config.tasks)) {
    throw new Error('Pages and tasks must be lists.');
  }
  const ids = new Set();
  config.pages = config.pages.map((page) => {
    const id = String(page.id || randomUUID());
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('Page IDs may contain only letters, numbers, hyphens, and underscores.');
    const normalized = {
      id,
      name: String(page.name || '').trim().slice(0, 100),
      enabled: page.enabled !== false,
      liveUrl: validOptionalUrl(page.liveUrl, 'Live URL'),
      previewUrl: validOptionalUrl(page.previewUrl, 'Preview URL'),
      productionUrl: validOptionalUrl(page.productionUrl, 'Production URL'),
      figmaUrl: validOptionalUrl(page.figmaUrl, 'Figma URL'),
      expectedTitle: String(page.expectedTitle || '').trim().slice(0, 200),
      expectedHeading: String(page.expectedHeading || '').trim().slice(0, 200),
      ignoreSelectors: Array.isArray(page.ignoreSelectors) ? page.ignoreSelectors.map(String).slice(0, 20) : [],
    };
    if (!normalized.name) throw new Error('Every page needs a name.');
    if (ids.has(normalized.id)) throw new Error(`Duplicate page ID: ${normalized.id}`);
    ids.add(normalized.id);
    return normalized;
  });
  const taskIds = new Set();
  config.tasks = config.tasks.map((task) => {
    const id = String(task.id || randomUUID());
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('Task IDs may contain only letters, numbers, hyphens, and underscores.');
    const normalized = {
      id,
      name: String(task.name || '').trim().slice(0, 120),
      pageId: String(task.pageId || ''),
      expectedResult: String(task.expectedResult || '').trim().slice(0, 1000),
      steps: Array.isArray(task.steps) ? task.steps.slice(0, 20) : [],
      approved: task.approved === true,
    };
    if (!normalized.name || !normalized.expectedResult || !normalized.pageId || !normalized.steps.length) {
      throw new Error('Each task needs a name, page, expected result, and at least one step.');
    }
    if (!ids.has(normalized.pageId)) throw new Error(`Task page does not exist: ${normalized.pageId}`);
    if (taskIds.has(normalized.id)) throw new Error(`Duplicate task ID: ${normalized.id}`);
    taskIds.add(normalized.id);
    normalized.steps.forEach(validateTaskStep);
    return normalized;
  });
  return config;
}

export function validOptionalUrl(value, label = 'URL') {
  const input = String(value || '').trim();
  if (!input) return '';
  let url;
  try { url = new URL(input); } catch { throw new Error(`${label} must be a complete URL, including https://`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label} must use http or https.`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials.`);
  return url.toString().replace(/\/$/, '');
}

export function validateTaskStep(step) {
  if (!step || typeof step !== 'object') throw new Error('Each task step must be an object.');
  const allowed = ['clickRole', 'clickText', 'fillLabel', 'expectText', 'expectUrl'];
  if (!allowed.includes(step.action)) throw new Error(`Unsupported task action: ${step.action || '(empty)'}`);
  if (typeof step.value !== 'string' || !step.value.trim()) throw new Error(`Task action ${step.action} needs a value.`);
  if (step.action === 'clickRole') {
    const risky = /checkout|place order|buy now|submit|purchase|subscribe|sign up|create account/i;
    if (risky.test(`${step.value} ${step.name || ''}`)) throw new Error('Task steps cannot submit forms, subscribe, create accounts, place orders, or enter checkout.');
  }
  if (step.action === 'clickText' && /checkout|place order|buy now|submit|purchase|subscribe|sign up|create account/i.test(step.value)) {
    throw new Error('Task steps cannot submit forms, subscribe, create accounts, place orders, or enter checkout.');
  }
  if (step.action === 'fillLabel') {
    if (typeof step.input !== 'string') throw new Error('fillLabel steps need an input value.');
    if (/password|passphrase|secret|token|api[ -]?key|credit[ -]?card|card[ -]?number|security[ -]?code|\bcvv\b|\bcvc\b|verification[ -]?code/i.test(step.value)) {
      throw new Error('Sensitive fields cannot be automated or stored in task specs.');
    }
  }
  return step;
}

export function buildIssue({ page, environment, category, title, summary, expected, actual, severity = 'Medium', evidence = [], steps = [], status = 'open' }) {
  return {
    id: `QA-${randomUUID().slice(0, 8).toUpperCase()}`,
    fingerprint: createHash('sha256').update(`${page.id}:${category}:${title}`).digest('hex').slice(0, 16),
    pageName: page.name,
    url: environment === 'preview' ? page.previewUrl : environment === 'production' ? page.productionUrl : page.liveUrl,
    environment,
    category,
    title,
    summary,
    expected,
    actual,
    severity,
    evidence,
    reproductionSteps: steps,
    nextAction: category === 'ui' ? 'Review the screenshots against Figma and approve the baseline only if this difference is intentional.' : 'Reproduce on the same URL and inspect the attached browser/network evidence.',
    status,
  };
}
