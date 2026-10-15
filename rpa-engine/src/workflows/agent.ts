import type { PlatformSkill, SkillContext } from '../skills/types.js';
import { collectCandidates } from './collect.js';

export type SearchTerm = { keyword: string };
export type RoundResult = { keyword: string; collectedCount: number; passedCount: number };
export interface AgentPlanner {
  start(projectId: string, profile: Record<string, unknown>, signal?: AbortSignal): Promise<{ id: string }>;
  terms(runId: string, signal?: AbortSignal): Promise<{ roundNumber: number; terms: SearchTerm[]; reason: string; promptVersion: string }>;
  record(runId: string, round: { roundNumber: number; terms: SearchTerm[]; results: RoundResult[]; promptVersion: string }, signal?: AbortSignal): Promise<unknown>;
}
export type AgentRound = { roundNumber: number; terms: SearchTerm[]; results: RoundResult[]; collectedCount: number; passedCount: number; passRate: number; reason: string };

/* DESIGN-DECISION: 无原始证据，自研 */
// The client owns browser execution. ctx.step retains authorization, pause,
// cancellation, and randomized platform rate limits from the RPA engine.
export async function runAgentRounds(skill: PlatformSkill, ctx: SkillContext, planner: AgentPlanner, input: { projectId: string; profile: Record<string, unknown>; jobTitle: string; targetPerTerm?: number; maxPages?: number }) {
  const run = await planner.start(input.projectId, input.profile, ctx.signal);
  const rounds: AgentRound[] = [];
  const candidates: Array<{ candidateRef: string; name: string; summary: string; initialScreen?: { excerpt?: string; error?: string } }> = [];
  for (let i = 1; i <= 2; i++) {
    if (ctx.signal.aborted) throw new Error('Agent operation cancelled');
    const suggestion = await planner.terms(run.id, ctx.signal);
    if (suggestion.roundNumber !== i || suggestion.terms.length < 1 || suggestion.terms.length > 3) throw new Error('Invalid agent term round');
    const results: RoundResult[] = [];
    for (const term of suggestion.terms) {
      const collected = await collectCandidates(skill, ctx, { jobTitle: input.jobTitle, keyword: term.keyword, targetCount: input.targetPerTerm ?? 10, maxPages: input.maxPages ?? 2 });
      for (const candidate of collected.candidates) if (!candidates.some(item => item.candidateRef === candidate.candidateRef)) candidates.push({ candidateRef: candidate.candidateRef, name: candidate.name, summary: candidate.summary, initialScreen: candidate.initialScreen });
      // Stage 6 initial screening is a local evidence check. It is a search
      // quality signal for the next round, not an employment decision.
      const passedCount = collected.candidates.filter(candidate => {
        const excerpt = candidate.initialScreen?.excerpt?.toLowerCase() ?? '';
        return Boolean(excerpt) && (excerpt.includes(input.jobTitle.toLowerCase()) || excerpt.includes(term.keyword.toLowerCase()));
      }).length;
      results.push({ keyword: term.keyword, collectedCount: collected.collectedCount, passedCount });
    }
    if (ctx.signal.aborted) throw new Error('Agent operation cancelled');
    await planner.record(run.id, { roundNumber: i, terms: suggestion.terms, results, promptVersion: suggestion.promptVersion }, ctx.signal);
    const collectedCount = results.reduce((n, item) => n + item.collectedCount, 0);
    const passedCount = results.reduce((n, item) => n + item.passedCount, 0);
    rounds.push({ roundNumber: i, terms: suggestion.terms, results, collectedCount, passedCount, passRate: collectedCount ? Math.round(passedCount / collectedCount * 100) : 0, reason: suggestion.reason });
  }
  return { runId: run.id, recruitmentMode: 'target', rounds, candidates };
}

export function cloudAgentPlanner(options: { baseUrl: string; accessToken: string; fetchImpl?: typeof fetch }): AgentPlanner {
  const call = options.fetchImpl ?? fetch;
  const request = async (path: string, body?: unknown, signal?: AbortSignal) => {
    const response = await call(`${options.baseUrl.replace(/\/$/, '')}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${options.accessToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Cloud agent request failed: ${response.status}`);
    return response.json() as Promise<any>;
  };
  return { start: (projectId, profile, signal) => request('/llm/agent/runs', { projectId, profile, recruitmentMode: 'target' }, signal), terms: (runId, signal) => request(`/llm/agent/runs/${runId}/terms`, {}, signal), record: (runId, round, signal) => request(`/llm/agent/runs/${runId}/rounds`, round, signal) };
}
