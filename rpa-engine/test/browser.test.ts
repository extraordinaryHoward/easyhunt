import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserManager } from '../src/browser.js';
import { OperationQueue } from '../src/operations.js';
import { BossSkill } from '../src/skills/boss/index.js';

test('real Chromium DOM, pause, manual edit, resume, and ad dismissal', async () => {
  const browser = new BrowserManager({ headless: true, minIntervalMs: 0 });
  try {
    const session = await browser.open({});
    const page = browser.get(session.sessionRef).page;
    await page.route('https://www.zhipin.com/web/boss/search/', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<div class="candidate-item">候选人 A</div><div role="dialog"><button aria-label="Close ad">关闭</button></div>' }));
    await page.goto('https://www.zhipin.com/web/boss/search/');
    browser.get(session.sessionRef).platform = 'boss';
    const queue = new OperationQueue();
    const skill = new BossSkill();
    browser.pause(session.sessionRef);
    const operation = queue.create('candidates.list', (signal) => skill.candidates.list({ page, sessionRef: session.sessionRef, signal, step: async () => { await browser.checkpoint(session.sessionRef, signal); } }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(queue.get(operation.operationId).status, 'running');
    await page.evaluate(() => { document.querySelector('.candidate-item')!.textContent = '候选人 B · 人工修改'; });
    browser.resume(session.sessionRef);
    for (let i = 0; i < 150 && queue.get(operation.operationId).status !== 'succeeded'; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const result = queue.get(operation.operationId).result as Array<{ summary: string }>;
    assert.match(result[0].summary, /人工修改/);
    const dismissed = await browser.dismissAd(session.sessionRef, new AbortController().signal);
    assert.equal(dismissed.method, 'click');
  } finally { await browser.close(); }
});
