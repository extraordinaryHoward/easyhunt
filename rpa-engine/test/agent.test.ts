import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlatformSkill, SkillContext } from '../src/skills/types.js';
import { runAgentRounds, type AgentPlanner } from '../src/workflows/agent.js';
import { remoteLlmScorer } from '../src/resume/llm-score.js';
import { ruleScore } from '../src/resume/score.js';
import type { Job, Resume } from '../src/resume/schema.js';

test('agent performs two skill searches and records aggregate quality for iteration', async () => {
  let keyword = '';
  let steps = 0;
  const stored: Array<{ roundNumber: number; results: Array<{ collectedCount: number; passedCount: number }> }> = [];
  const skill: PlatformSkill = {
    platform: 'boss', pages: {}, resolveSessionRef: () => 'test-session',
    search: { fields: async () => ['keyword'], get: async () => keyword, set: async (ctx, _field, value) => { await ctx.step(); keyword = String(value); }, apply: async ctx => { await ctx.step(); } },
    candidates: { list: async ctx => { await ctx.step(); return Array.from({ length: keyword === 'Java 后端' ? 10 : 8 }, (_, index) => ({ candidateRef: `${keyword}-${index}`, name: `候选人${index}`, summary: `${keyword} 项目` })); }, next: async () => false },
    resume: { open: async () => {}, read: async (ctx, ref) => { await ctx.step(); const index = Number(ref.split('-').at(-1)); return index < (keyword === 'Java 后端' ? 2 : 4) ? '后端工程师项目经历' : '其他岗位经历'; }, close: async () => {} },
    jobs: { list: async () => [], select: async () => {}, description: async () => '' },
  };
  const ctx: SkillContext = { page: { url: () => 'https://www.zhipin.com/web/boss/search/' } as SkillContext['page'], sessionRef: 'test-session', signal: new AbortController().signal, step: async () => { steps++; } };
  const planner: AgentPlanner = { start: async () => ({ id: 'run-1' }), terms: async () => ({ roundNumber: stored.length + 1, terms: [{ keyword: stored.length ? 'Redis 订单' : 'Java 后端' }], reason: stored.length ? `上一轮通过率 ${Math.round(stored[0].results[0].passedCount / stored[0].results[0].collectedCount * 100)}%` : '初始搜索', promptVersion: 'v1' }), record: async (_runId, round) => { stored.push(round); } };
  const result = await runAgentRounds(skill, ctx, planner, { projectId: 'p1', profile: { hardConditions: [] }, jobTitle: '后端工程师', targetPerTerm: 10, maxPages: 1 });
  assert.equal(result.rounds.length, 2);
  assert.deepEqual(result.rounds.map(round => [round.collectedCount, round.passedCount, round.passRate]), [[10, 2, 20], [8, 4, 50]]);
  assert.equal(stored.length, 2);
  assert.ok(steps > 0);
});

test('remote LLM scorer uses valid evidence and falls back to rule score on failure', async () => {
  const resume: Resume = { name: '陈伟', skills: ['Redis'], workExperiences: [], educationExperiences: [{ school: '某大学', degree: '本科' }], totalExperienceYears: 8 };
  const job: Job = { title: '后端', requiredSkills: ['Redis'], minimumDegree: '本科', minimumExperienceYears: 5, weights: { degree: 0.25, experience: 0.3, skills: 0.45 } };
  const sourceText = '教育经历：某大学|本科\n工作年限：8年\n技能：Redis';
  const valid = remoteLlmScorer({ baseUrl: 'http://local', accessToken: 'token', allowRemoteResumeProcessing: true, fetchImpl: async () => new Response(JSON.stringify({ result: { stars: 4, score: 80, analysis: { matched: [{ content: 'Redis', evidence: ['技能：Redis'] }], mismatched: [], pending: [] } } })) });
  assert.equal((await valid(resume, job, sourceText)).stars, 4);
  const invalid = remoteLlmScorer({ baseUrl: 'http://local', accessToken: 'token', allowRemoteResumeProcessing: true, fetchImpl: async () => new Response(JSON.stringify({ result: { stars: 5, score: 100, analysis: { matched: [{ content: '虚构', evidence: ['不存在'] }], mismatched: [], pending: [] } } })) });
  assert.deepEqual(await invalid(resume, job, sourceText), ruleScore(resume, job, sourceText));
});
