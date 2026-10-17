import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { MemoryCodeStore } from '../src/auth.js';
import { migrate, pgliteDb } from '../src/db.js';

test('batch decisions and explicit encrypted sharing enforce READ/EDIT permissions', async () => {
  const db = pgliteDb();
  await migrate(db);
  const sent = new Map<string, string>();
  const app = buildApp({ db, codes: new MemoryCodeStore(), jwtSecret: 'test-secret-at-least-32-characters-long', shareKey: '11'.repeat(32), sendSms: async (phone, code) => { sent.set(phone, code); } });
  const call = async (method: string, url: string, payload?: unknown, token?: string) => { const response = await app.inject({ method: method as 'GET', url, payload: payload as Record<string, unknown> | undefined, headers: token ? { authorization: `Bearer ${token}` } : {} }); return { status: response.statusCode, body: response.json() }; };
  const login = async (phone: string) => { await call('POST', '/auth/send-code', { phone }); const result = await call('POST', '/auth/login', { phone, code: sent.get(phone) }); return result.body; };
  try {
    const owner = await login('13800009001');
    const reader = await login('13800009002');
    const editor = await login('13800009003');
    const ownerToken = owner.accessToken;
    const project = await call('POST', '/project', { title: '测试分享' }, ownerToken);
    const resume = await call('POST', '/resumes', { projectId: project.body.id, localRef: 'opaque-1', contentHash: 'c'.repeat(64), displayName: '陈某' }, ownerToken);
    const decision = await call('POST', '/resumes/decision', { resumeIds: [resume.body.id], decisionStatus: 'CONSIDERING' }, ownerToken);
    assert.equal(decision.body.updatedCount, 1);
    const denied = await call('POST', `/resume/${resume.body.id}/shares`, { audience: 'all', content: { sourceText: '用户选择的片段' }, confirmed: false }, ownerToken);
    assert.equal(denied.status, 400);
    const share = await call('POST', `/resume/${resume.body.id}/shares`, { audience: 'recipients', recipients: [{ userId: reader.account.id, permission: 'READ' }, { userId: editor.account.id, permission: 'EDIT' }], content: { sourceText: '用户选择的片段' }, confirmed: true }, ownerToken);
    assert.equal(share.status, 200);
    const stored = await db.query<{ encrypted_content: string }>('SELECT encrypted_content FROM resume_shares WHERE id=$1', [share.body.id]);
    assert.ok(!stored[0].encrypted_content.includes('用户选择的片段'));
    assert.equal((await call('GET', `/resume/${resume.body.id}/shares/${share.body.id}`, undefined, reader.accessToken)).body.content.sourceText, '用户选择的片段');
    assert.equal((await call('PUT', `/resume/${resume.body.id}/shares/${share.body.id}`, { content: { sourceText: '修改' } }, reader.accessToken)).body.error.code, 'SHARE_READ_ONLY');
    assert.equal((await call('PUT', `/resume/${resume.body.id}/shares/${share.body.id}`, { content: { sourceText: '编辑后的片段' } }, editor.accessToken)).body.updated, true);
    assert.equal((await call('GET', `/resume/${resume.body.id}/shares/${share.body.id}`, undefined, reader.accessToken)).body.content.sourceText, '编辑后的片段');
    assert.equal((await call('GET', '/resumes/shared', undefined, reader.accessToken)).body.items.length, 1);
    const publicShare = await call('POST', `/resume/${resume.body.id}/shares`, { audience: 'all', content: { sourceText: '面向全部登录账户' }, confirmed: true }, ownerToken);
    assert.equal((await call('GET', `/resume/${resume.body.id}/shares/${publicShare.body.id}`, undefined, reader.accessToken)).body.permission, 'READ');
    assert.ok(new Date(share.body.expiresAt).getTime() > Date.now());
    await db.query("UPDATE resume_shares SET expires_at=now() - interval '1 second' WHERE id=$1", [share.body.id]);
    assert.equal((await call('GET', `/resume/${resume.body.id}/shares/${share.body.id}`, undefined, reader.accessToken)).body.error.code, 'SHARE_EXPIRED');
    assert.equal((await call('GET', '/resumes/shared', undefined, reader.accessToken)).body.items.length, 1);
    assert.equal((await call('GET', '/resume/share-users/lookup?phone=13800009002', undefined, ownerToken)).body.userId, reader.account.id);
  } finally { await app.close(); await db.close(); }
});
