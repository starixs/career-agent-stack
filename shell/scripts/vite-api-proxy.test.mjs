import assert from 'node:assert/strict';
import { test } from 'node:test';

import { API_PROXY_PATTERN } from './vite-api-proxy.mjs';

const proxied = (url) => new RegExp(API_PROXY_PATTERN).test(url);

test('backend endpoints under /api are proxied', () => {
  assert.equal(proxied('/api/sessions'), true);
  assert.equal(proxied('/api/sessions/123?limit=20'), true);
  assert.equal(proxied('/api/cc-plugin/list'), true);
});

test('renderer source modules under /api stay with Vite, including HMR query strings', () => {
  assert.equal(proxied('/api/spaceCloud.ts'), false);
  assert.equal(proxied('/api/spaceCloud.ts?t=1791644808369'), false);
  assert.equal(proxied('/api/eventBus.ts?import'), false);
  assert.equal(proxied('/api/widget.tsx?t=1&v=2'), false);
});
