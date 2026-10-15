import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { MemoryCodeStore } from '../src/auth.js';
import { migrate, pgliteDb } from '../src/db.js';
import { LlmClient, type ChatTransport } from '../src/llm/client.js';
import { LlmService } from '../src/llm/service.js';

const config = { model: 'test-model', baseUrl: 'https://model.example', apiKey: 'test-key', timeoutMs: 1000, retries: 1, perHourLimit: 30 };
const completion = (content: unknown, status = 200) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status });

test('JD profile, resume evidence, extraction, and two persisted search rounds', async () => {
  const db = pgliteDb();
  await migrate(db);
  const counters = new MemoryCodeStore();
  const termInputs: unknown[] = [];
  const transport: ChatTransport = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    const system = body.messages[0].content;
    const user = body.messages[1].content;
    if (system.includes('招聘画像分析')) return completion({ hardConditions: [{ content: '本科', evidence: ['本科'] }], businessConditions: [{ content: '订单系统', evidence: ['订单系统'] }], bonusItems: [{ content: 'Redis', evidence: ['Redis'] }] });
    if (system.includes('简历匹配分析')) return completion({ stars: 5, score: 90, analysis: { matched: [{ content: '掌握 Redis', evidence: ['Redis'] }], mismatched: [], pending: [{ content: '稳定性待确认', evidence: [] }] } });
    if (system.includes('简历结构化')) return completion({ name: '陈伟', skills: ['Redis'], workExperiences: [], educationExperiences: [] });
    if (system.includes('搜索策略')) { const input = JSON.parse(user); termInputs.push(input); return completion({ terms: [{ keyword: termInputs.length === 1 ? 'Java 后端' : 'Redis 订单系统' }], reason: termInputs.length === 1 ? '初始搜索' : '根据通过率调整' }); }
    return completion({});
  };
  const llm = new LlmService(new LlmClient(config, counters, transport));
  let code = '';
  const app = buildApp({ db, codes: counters, jwtSecret: 'test-secret-at-least-32-characters-long', sendSms: async (_phone, otp) => { code = otp; }, llmService: llm });
  const call = async (method: string, url: string, payload?: unknown, token?: string) => { const r = await app.inject({ method: method as 'GET', url, payload: payload as Record<string, unknown> | undefined, headers: token ? { authorization: `Bearer ${token}` } : {} }); return { status: r.statusCode, body: r.json() }; };
  try {
    await call('POST', '/auth/send-code', { phone: '13800008888' });
    const login = await call('POST', '/auth/login', { phone: '13800008888', code });
    const token = login.body.accessToken as string;
    const jd = '招聘本科以上 Java 后端工程师，负责订单系统，有 Redis 经验加分。';
    const profile = await call('POST', '/llm/profile', { jd }, token);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.profile.hardConditions[0].evidence[0], '本科');
    assert.equal(profile.body.promptVersion, 'v1');
    const noConsent = await call('POST', '/llm/resume-score', { job: {}, resume: {}, sourceText: 'Redis' }, token);
    assert.equal(noConsent.status, 400);
    const score = await call('POST', '/llm/resume-score', { job: {}, resume: {}, sourceText: '技能：Redis', allowRemoteResumeProcessing: true }, token);
    assert.equal(score.body.result.stars, 5);
    const extracted = await call('POST', '/llm/resume-extract', { sourceText: '姓名：陈伟\n技能：Redis', schema: 'resume-v1', allowRemoteResumeProcessing: true }, token);
    assert.equal(extracted.body.resume.name, '陈伟');
    const project = await call('POST', '/project', { title: '后端岗位' }, token);
    const run = await call('POST', '/llm/agent/runs', { projectId: project.body.id, recruitmentMode: 'target', profile: profile.body.profile }, token);
    assert.equal(run.status, 200);
    const firstTerms = await call('POST', `/llm/agent/runs/${run.body.id}/terms`, {}, token);
    assert.equal(firstTerms.body.roundNumber, 1);
    await call('POST', `/llm/agent/runs/${run.body.id}/rounds`, { roundNumber: 1, terms: firstTerms.body.terms, results: [{ keyword: 'Java 后端', collectedCount: 10, passedCount: 2 }], promptVersion: 'v1' }, token);
    const secondTerms = await call('POST', `/llm/agent/runs/${run.body.id}/terms`, {}, token);
    assert.equal(secondTerms.body.roundNumber, 2);
    assert.equal((termInputs[1] as { previousRounds: Array<{ pass_rate: number }> }).previousRounds[0].pass_rate, 20);
    await call('POST', `/llm/agent/runs/${run.body.id}/rounds`, { roundNumber: 2, terms: secondTerms.body.terms, results: [{ keyword: 'Redis 订单系统', collectedCount: 8, passedCount: 4 }], promptVersion: 'v1' }, token);
    const history = await call('GET', `/llm/agent/runs/${run.body.id}`, undefined, token);
    assert.deepEqual(history.body.rounds.map((r: { pass_rate: number }) => r.pass_rate), [20, 50]);
    assert.equal(history.body.run.status, 'completed');
  } finally { await app.close(); await db.close(); }
});

test('LLM transport retries recoverable error and limits requests by account', async () => {
  const counters = new MemoryCodeStore();
  let calls = 0;
  const transport: ChatTransport = async () => { calls++; return calls === 1 ? new Response('', { status: 503 }) : completion({ ok: true }); };
  const client = new LlmClient({ ...config, perHourLimit: 1 }, counters, transport);
  const text = await client.chat('account-1', [{ role: 'user', content: 'hello' }], true);
  assert.match(text, /ok/);
  assert.equal(calls, 2);
  await assert.rejects(() => client.chat('account-1', [{ role: 'user', content: 'again' }]), (error: { code?: string }) => error.code === 'LLM_RATE_LIMITED');
});

test('profile rejects invented evidence', async () => {
  const service = new LlmService(new LlmClient(config, new MemoryCodeStore(), async () => completion({ hardConditions: [{ content: '博士', evidence: ['博士'] }], businessConditions: [], bonusItems: [] })));
  await assert.rejects(() => service.profile('account-2', '招聘本科以上后端工程师，负责订单系统开发。'), (error: { code?: string }) => error.code === 'LLM_EVIDENCE_INVALID');
});
