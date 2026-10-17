import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { buildApp } from '../src/app.js';
import type { BrowserManager } from '../src/browser.js';

class FakeBrowser {
  sessions = new Map<string, { sessionRef: string; platform: string; paused: boolean; url: string }>();
  async open() { const session = { sessionRef: 'fake-session', platform: 'boss', paused: false, url: 'https://www.zhipin.com/web/boss/search/' }; this.sessions.set(session.sessionRef, session); return session; }
  list() { return [...this.sessions.values()]; }
  get(ref: string) { const session = this.sessions.get(ref); if (!session) throw new Error('missing session'); return session; }
  pause(ref: string) { this.get(ref).paused = true; }
  resume(ref: string) { this.get(ref).paused = false; }
  async state(ref: string) { return { ...this.get(ref), title: 'Mock', bodyText: 'Manual page' }; }
  async candidates(ref: string) { return { sessionRef: ref, candidates: [{ text: 'Candidate' }], count: 1 }; }
  async dismissAd() { return { dismissed: false, method: 'escape' }; }
  async close() {}
}
const fake = new FakeBrowser();
const app = buildApp({ browser: fake as unknown as BrowserManager, bridgeSecret: 'test-desktop-secret' });
before(async () => { await app.ready(); });
after(async () => { await app.close(); });

async function create(action: string, other: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: '/operations', payload: { action, ...other } });
}

async function poll(id: string, expected: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await app.inject({ method: 'GET', url: `/operations/${id}` });
    const body = response.json();
    if (body.status === expected) return body;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(`operation ${id} did not reach ${expected}`);
}

test('create, poll, and cancel pending operation', async () => {
  const response = await create('jobs.open', { jobRef: 'job-pending' });
  assert.equal(response.statusCode, 202);
  const { operationId } = response.json();
  assert.equal((await app.inject({ method: 'GET', url: `/operations/${operationId}` })).json().status, 'pending');
  const cancelled = await app.inject({ method: 'POST', url: `/operations/${operationId}/cancel` });
  assert.equal(cancelled.json().status, 'cancelled');
  assert.equal((await poll(operationId, 'cancelled')).status, 'cancelled');
});

test('operation runs and succeeds with mock result', async () => {
  const response = await create('jobs.open', { jobRef: 'job-1' });
  const result = await poll(response.json().operationId, 'succeeded');
  assert.equal(result.result.action, 'jobs.open');
  assert.equal(result.result.mock, true);
  const lateCancel = await app.inject({ method: 'POST', url: `/operations/${result.operationId}/cancel` });
  assert.equal(lateCancel.statusCode, 409);
  assert.equal(lateCancel.json().error.code, 'OPERATION_FINISHED');
});

test('required fields and confirmation are enforced', async () => {
  const missing = await create('search.set', { sessionRef: 's', contextRef: 'c', field: 'city' });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error.code, 'MISSING_PARAMETER');
  const unconfirmed = await create('candidates.greet', { candidateRef: 'c', jobRef: 'j', confirmed: false, messageMode: 'default' });
  assert.equal(unconfirmed.statusCode, 400);
  assert.equal(unconfirmed.json().error.code, 'CONFIRMATION_REQUIRED');
});

test('status, sessions, browser open, and pause/resume', async () => {
  const status = await app.inject({ method: 'GET', url: '/status' });
  assert.equal(status.json().commandCount, 31);
  const authorization = await app.inject({ method: 'POST', url: '/authorizations', headers: { 'x-easyhunt-bridge-secret': 'test-desktop-secret' }, payload: { platform: 'boss', phone: '13800138000', authorized: true, signedAgreement: true } });
  assert.equal(authorization.statusCode, 200);
  const browser = await app.inject({ method: 'POST', url: '/browser/open', payload: { platform: 'boss' } });
  const ref = browser.json().browser.sessionRef;
  assert.equal((await app.inject({ method: 'GET', url: '/sessions' })).json().sessions.some((s: { sessionRef: string }) => s.sessionRef === ref), true);
  const pause = await app.inject({ method: 'POST', url: `/sessions/${ref}/control`, payload: { action: 'session.pause' } });
  await poll(pause.json().operationId, 'succeeded');
  assert.equal((await app.inject({ method: 'GET', url: '/sessions' })).json().sessions.find((s: { sessionRef: string }) => s.sessionRef === ref).paused, true);
  const resume = await app.inject({ method: 'POST', url: `/sessions/${ref}/control`, payload: { action: 'session.resume' } });
  await poll(resume.json().operationId, 'succeeded');
  assert.equal((await app.inject({ method: 'GET', url: '/sessions' })).json().sessions.find((s: { sessionRef: string }) => s.sessionRef === ref).paused, false);
});

test('task routes and missing resources', async () => {
  const created = await app.inject({ method: 'POST', url: '/tasks', payload: { inputFile: { requestId: 'req-1' } } });
  assert.equal(created.statusCode, 201);
  const id = created.json().task.taskId;
  assert.equal((await app.inject({ method: 'GET', url: `/tasks/${id}` })).json().task.input.requestId, 'req-1');
  assert.equal((await app.inject({ method: 'GET', url: '/tasks' })).json().tasks.length, 1);
  assert.equal((await app.inject({ method: 'GET', url: '/operations/absent' })).statusCode, 404);
});

test('signed authorization gates browser access and revocation pauses sessions', async () => {
  const isolatedFake = new FakeBrowser();
  const isolated = buildApp({ browser: isolatedFake as unknown as BrowserManager, bridgeSecret: 'test-desktop-secret' });
  await isolated.ready();
  try {
    const denied = await isolated.inject({ method: 'POST', url: '/browser/open', payload: { platform: 'boss' } });
    assert.equal(denied.statusCode, 403);
    const forged = await isolated.inject({ method: 'POST', url: '/authorizations', payload: { platform: 'boss', phone: '13800138000', authorized: true, signedAgreement: true } });
    assert.equal(forged.json().error.code, 'AUTHORIZATION_BRIDGE_REQUIRED');
    const unsigned = await isolated.inject({ method: 'POST', url: '/authorizations', headers: { 'x-easyhunt-bridge-secret': 'test-desktop-secret' }, payload: { platform: 'boss', phone: '13800138000', authorized: true, signedAgreement: false } });
    assert.equal(unsigned.statusCode, 400);
    await isolated.inject({ method: 'POST', url: '/authorizations', headers: { 'x-easyhunt-bridge-secret': 'test-desktop-secret' }, payload: { platform: 'boss', phone: '13800138000', authorized: true, signedAgreement: true } });
    const opened = await isolated.inject({ method: 'POST', url: '/browser/open', payload: { platform: 'boss' } });
    assert.equal(opened.statusCode, 200);
    await isolated.inject({ method: 'DELETE', url: '/authorizations/boss' });
    assert.equal(isolatedFake.get('fake-session').paused, true);
    const blocked = await isolated.inject({ method: 'POST', url: '/operations', payload: { action: 'candidates.list', sessionRef: 'fake-session', contextRef: 'current-page' } });
    assert.equal(blocked.statusCode, 403);
  } finally { await isolated.close(); }
});
