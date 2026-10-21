import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, validOptionalUrl, validateTaskStep } from '../qa/lib.mjs';

test('accepts independent full URLs for each environment', () => {
  const config = normalizeConfig({ pages: [{ id: 'one', name: 'Product', liveUrl: 'https://live.test/products/one', previewUrl: 'https://pr-42.test/item-one', productionUrl: 'https://shop.test/p/sku-one' }] });
  assert.equal(config.pages[0].liveUrl, 'https://live.test/products/one');
  assert.equal(config.pages[0].previewUrl, 'https://pr-42.test/item-one');
  assert.equal(config.pages[0].productionUrl, 'https://shop.test/p/sku-one');
});

test('rejects invalid, credential-bearing, and non-web URLs', () => {
  assert.throws(() => validOptionalUrl('example.com'), /complete URL/);
  assert.throws(() => validOptionalUrl('javascript:alert(1)'), /http or https/);
  assert.throws(() => validOptionalUrl('https://user:secret@example.com'), /must not contain credentials/);
});

test('rejects filesystem traversal identifiers from imported configuration', () => {
  assert.throws(() => normalizeConfig({ pages: [{ id: '../outside', name: 'Unsafe page ID' }] }), /Page IDs may contain only/);
  assert.throws(() => normalizeConfig({ pages: [{ id: 'safe', name: 'Page' }], tasks: [{ id: '../task', pageId: 'safe', name: 'Unsafe task ID', expectedResult: 'Result', steps: [{ action: 'expectText', value: 'OK' }] }] }), /Task IDs may contain only/);
});

test('requires task details, a configured page, and explicit approval to run', () => {
  const config = normalizeConfig({ pages: [{ id: 'home', name: 'Home' }], tasks: [{ id: 'task', pageId: 'home', name: 'CTA', expectedResult: 'Product page is visible', approved: false, steps: [{ action: 'expectText', value: 'Product' }] }] });
  assert.equal(config.tasks[0].approved, false);
  assert.throws(() => normalizeConfig({ tasks: [{ name: 'Orphan', pageId: 'missing', expectedResult: 'Works', steps: [{ action: 'expectText', value: 'ok' }] }] }), /Task page does not exist/);
});

test('blocks task steps that can submit or purchase', () => {
  assert.throws(() => validateTaskStep({ action: 'clickRole', value: 'button', name: 'Place order' }), /cannot submit forms/);
  assert.throws(() => validateTaskStep({ action: 'clickText', value: 'Subscribe now' }), /cannot submit forms/);
  assert.throws(() => validateTaskStep({ action: 'clickRole', value: 'button', name: 'Checkout' }), /cannot submit forms/);
  assert.doesNotThrow(() => validateTaskStep({ action: 'clickRole', value: 'link', name: 'Shop now' }));
  assert.throws(() => validateTaskStep({ action: 'fillLabel', value: 'Account password', input: 'secret' }), /Sensitive fields/);
  assert.throws(() => validateTaskStep({ action: 'fillLabel', value: 'Card number', input: '4111111111111111' }), /Sensitive fields/);
  assert.doesNotThrow(() => validateTaskStep({ action: 'fillLabel', value: 'Email address', input: 'qa@example.test' }));
});

test('rejects malformed task step definitions', () => {
  assert.throws(() => validateTaskStep({ action: 'clickCSS', value: '.buy' }), /Unsupported task action/);
  assert.throws(() => validateTaskStep({ action: 'fillLabel', value: 'Email' }), /need an input value/);
});
