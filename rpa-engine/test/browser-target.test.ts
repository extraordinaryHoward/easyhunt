import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Browser, BrowserContext, Page } from 'playwright';
import { BrowserManager } from '../src/browser.js';
import { buildApp } from '../src/app.js';

test('BrowserView target registration requires the desktop bridge secret', async () => {
  const previous = process.env.EASYHUNT_BRIDGE_SECRET;
  process.env.EASYHUNT_BRIDGE_SECRET = 'test-only-bridge-secret';
  const app = buildApp({ browser: new BrowserManager() });
  try {
    const denied = await app.inject({ method: 'POST', url: '/bridge/target', payload: { targetId: 'A'.repeat(32) } });
    assert.equal(denied.statusCode, 403);
    const accepted = await app.inject({ method: 'POST', url: '/bridge/target', headers: { 'x-easyhunt-bridge-secret': 'test-only-bridge-secret' }, payload: { targetId: 'A'.repeat(32) } });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(accepted.json(), { registered: true });
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.EASYHUNT_BRIDGE_SECRET;
    else process.env.EASYHUNT_BRIDGE_SECRET = previous;
  }
});

test('CDP target identity survives navigation and repeated browser.open calls', async () => {
  const targetId = 'A'.repeat(32);
  let currentUrl = 'https://example.test/already-navigated';
  let cdpLookups = 0;
  const page = {
    url: () => currentUrl,
    isClosed: () => false,
    goto: async (url: string) => { currentUrl = url; },
  } as Page;
  const otherPage = { url: () => 'file:///toolbar.html', isClosed: () => false } as Page;
  const context = {
    pages: () => [otherPage, page],
    newCDPSession: async (candidate: Page) => ({
      send: async () => { cdpLookups++; return { targetInfo: { targetId: candidate === page ? targetId : 'B'.repeat(32) } }; },
      detach: async () => {},
    }),
  } as unknown as BrowserContext;
  const manager = new BrowserManager({ cdpUrl: 'http://127.0.0.1:9223' });
  const internals = manager as unknown as { browser: Browser; context: BrowserContext };
  internals.browser = { close: async () => {} } as Browser;
  internals.context = context;
  manager.registerEmbeddedTarget(targetId);

  const first = await manager.open({});
  assert.equal(first.url, 'https://example.test/already-navigated');
  const lookupsAfterBinding = cdpLookups;
  const second = await manager.open({ platform: 'boss', page: 'search' });
  assert.equal(second.sessionRef, first.sessionRef);
  assert.match(second.url, /^https:\/\/www\.zhipin\.com\//);
  assert.equal(cdpLookups, lookupsAfterBinding);
  const third = await manager.open({});
  assert.equal(third.sessionRef, first.sessionRef);
  assert.equal(third.url, second.url);
});

test('browser.open reports the actual URL after an unexpected redirect', async () => {
  const targetId = 'C'.repeat(32);
  let currentUrl = 'http://127.0.0.1:4317/bridge/view';
  const page = {
    url: () => currentUrl,
    isClosed: () => false,
    goto: async () => { currentUrl = 'https://example.test/redirected'; },
  } as Page;
  const context = {
    pages: () => [page],
    newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId } }), detach: async () => {} }),
  } as unknown as BrowserContext;
  const manager = new BrowserManager({ cdpUrl: 'http://127.0.0.1:9223' });
  const internals = manager as unknown as { browser: Browser; context: BrowserContext };
  internals.browser = { close: async () => {} } as Browser;
  internals.context = context;
  manager.registerEmbeddedTarget(targetId);
  await assert.rejects(manager.open({ platform: 'boss', page: 'search' }), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'NAVIGATION_FAILED');
    assert.match((error as Error).message, /https:\/\/example\.test\/redirected/);
    return true;
  });
});
