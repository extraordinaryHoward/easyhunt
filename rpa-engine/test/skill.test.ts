import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserManager } from '../src/browser.js';
import { BossSkill } from '../src/skills/boss/index.js';
import { RateLimiter } from '../src/rate-limit.js';
import { collectCandidates } from '../src/workflows/collect.js';
import { OperationQueue } from '../src/operations.js';
import { buildApp } from '../src/app.js';

const fixture = `<!doctype html><meta charset="utf-8"><input name="keyword" placeholder="搜索人才"><button type="submit" id="search">搜索</button><a id="manager" href="#jobs">职位管理</a><div data-job-id="j1" hidden><span class="job-title">前端工程师</span><button data-testid="select-job">选择</button></div><main id="cards"></main><button data-testid="next-page">下一页</button><div data-testid="resume-detail" hidden><button data-testid="resume-close">关闭</button><p id="resume-text"></p></div><script>
let page=0;const cards=document.querySelector('#cards');const detail=document.querySelector('[data-testid="resume-detail"]');
function render(){cards.innerHTML='';for(let i=1;i<=10;i++){const n=page*10+i;const card=document.createElement('div');card.setAttribute('data-candidate-id','c'+n);card.innerHTML='<h3>候选人'+n+'</h3><span>前端工程师 关键词 3年经验</span>';card.onclick=()=>{detail.hidden=false;document.querySelector('#resume-text').textContent='候选人'+n+' 简历：前端工程师项目经验';};cards.append(card);}}
document.querySelector('#search').onclick=()=>{page=0;render()};document.querySelector('#manager').onclick=()=>{document.querySelector('[data-job-id]').hidden=false};document.querySelector('[data-testid="next-page"]').onclick=()=>{if(page<1){page++;render()}};
document.querySelector('[data-testid="resume-close"]').onclick=()=>{detail.hidden=true};document.querySelector('[data-testid="select-job"]').onclick=(e)=>{e.target.dataset.selected='true'};render();
</script>`;

test('BOSS skill search, jobs, 20 candidates across pages, and resume details', async () => {
  const browser = new BrowserManager({ headless: true, minIntervalMs: 0 });
  try {
    const session = await browser.open({});
    const page = browser.get(session.sessionRef).page;
    await page.route('https://www.zhipin.com/web/boss/search/', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }));
    await page.goto('https://www.zhipin.com/web/boss/search/');
    const skill = new BossSkill();
    const signal = new AbortController().signal;
    const ctx = { page, sessionRef: session.sessionRef, signal, step: async () => { await browser.checkpoint(session.sessionRef, signal); } };
    assert.deepEqual(await skill.search.fields(ctx), ['keyword']);
    await skill.search.set(ctx, 'keyword', '关键词');
    assert.equal(await skill.search.get(ctx, 'keyword'), '关键词');
    const jobs = await skill.jobs.list(ctx);
    assert.equal(jobs[0].title, '前端工程师');
    await skill.jobs.select(ctx, jobs[0].jobRef);
    assert.equal(await page.locator('[data-testid="select-job"]').getAttribute('data-selected'), 'true');
    const result = await collectCandidates(skill, ctx, { jobTitle: '前端工程师', keyword: '关键词', targetCount: 20, maxPages: 3 });
    assert.equal(result.collectedCount, 20);
    assert.equal(result.pagesRead, 2);
    assert.equal(new Set(result.candidates.map((candidate) => candidate.candidateRef)).size, 20);
    assert.match(result.candidates[0].initialScreen?.excerpt ?? '', /简历/);
    await page.setContent('<div class="candidate-item"><h3>备用选择器候选人</h3></div>');
    assert.equal((await skill.candidates.list(ctx))[0].name, '备用选择器候选人');
    await page.setContent('<div class="unrelated-card">不是候选人</div>');
    await assert.rejects(() => skill.candidates.list(ctx), (error: { code?: string }) => error.code === 'DOM_UNRECOGNIZED');
  } finally { await browser.close(); }
});

test('hourly rate limit and operation lifecycle logs', async () => {
  const signal = new AbortController().signal;
  const limiter = new RateLimiter({ minDelayMs: 0, maxDelayMs: 0, maxPerHour: 2 }, () => 1, () => 0);
  await limiter.take(signal);
  await limiter.take(signal);
  await assert.rejects(() => limiter.take(signal), (error: { code?: string }) => error.code === 'RATE_LIMITED');
  const states: string[] = [];
  const queue = new OperationQueue(({ status }) => states.push(status));
  const operation = queue.create('boss.collect', async () => 'done');
  for (let i = 0; i < 30 && queue.get(operation.operationId).status !== 'succeeded'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(states, ['pending', 'running', 'succeeded']);
});

test('HTTP dispatches BOSS skill and rejects sensitive actions without confirmation', async () => {
  const browser = new BrowserManager({ headless: true, minIntervalMs: 0 });
  const app = buildApp({ browser, rateLimiter: new RateLimiter({ minDelayMs: 0, maxDelayMs: 0, maxPerHour: 1000 }) });
  await app.ready();
  try {
    const session = await browser.open({});
    const page = browser.get(session.sessionRef).page;
    await page.route('https://www.zhipin.com/web/boss/search/', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }));
    await page.goto('https://www.zhipin.com/web/boss/search/');
    browser.get(session.sessionRef).platform = 'boss';
    await app.inject({ method: 'POST', url: '/authorizations', payload: { platform: 'boss', phone: '13800138000', authorized: true, signedAgreement: true } });
    const started = await app.inject({ method: 'POST', url: '/operations', payload: { action: 'candidates.list', sessionRef: session.sessionRef, contextRef: 'current-page' } });
    assert.equal(started.statusCode, 202);
    let operation: any;
    for (let i = 0; i < 100; i++) {
      operation = (await app.inject({ method: 'GET', url: `/operations/${started.json().operationId}` })).json();
      if (operation.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(operation.result.count, 10);
    const candidateRef = operation.result.candidates[0].candidateRef;
    const denied = await app.inject({ method: 'POST', url: '/operations', payload: { action: 'candidates.favorite', candidateRef, confirmed: false } });
    assert.equal(denied.json().error.code, 'CONFIRMATION_REQUIRED');
    const noFakeSuccess = await app.inject({ method: 'POST', url: '/operations', payload: { action: 'candidates.favorite', candidateRef, confirmed: true } });
    assert.equal(noFakeSuccess.statusCode, 501);
    const workflow = await app.inject({ method: 'POST', url: '/workflows/boss/collect', payload: { sessionRef: session.sessionRef, jobTitle: '前端工程师', keyword: '关键词', targetCount: 1 } });
    assert.equal(workflow.statusCode, 202);
    let collected: any;
    for (let i = 0; i < 100; i++) {
      collected = (await app.inject({ method: 'GET', url: `/operations/${workflow.json().operationId}` })).json();
      if (['succeeded', 'failed'].includes(collected.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(collected.status, 'succeeded');
    assert.equal(collected.result.collectedCount, 1);
  } finally { await app.close(); }
});
