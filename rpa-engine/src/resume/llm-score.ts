import { z } from 'zod';
import type { ResumeScorer } from './score.js';
import { ruleScore } from './score.js';

const item = z.object({ content: z.string().min(1), evidence: z.array(z.string()) });
const scoreSchema = z.object({ stars: z.number().int().min(1).max(5), score: z.number().int().min(0).max(100), analysis: z.object({ matched: z.array(item), mismatched: z.array(item), pending: z.array(item) }) });

export function remoteLlmScorer(options: { baseUrl: string; accessToken: string; allowRemoteResumeProcessing: true; fetchImpl?: typeof fetch }): ResumeScorer {
  const call = options.fetchImpl ?? fetch;
  return async (resume, job, sourceText) => {
    try {
      const response = await call(`${options.baseUrl.replace(/\/$/, '')}/llm/resume-score`, { method: 'POST', headers: { authorization: `Bearer ${options.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ job, resume, sourceText, allowRemoteResumeProcessing: true }), signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`LLM score returned ${response.status}`);
      const body = await response.json() as { result?: unknown };
      const result = scoreSchema.parse(body.result);
      for (const group of Object.values(result.analysis)) for (const entry of group) for (const evidence of entry.evidence) if (!sourceText.includes(evidence)) throw new Error('LLM evidence is not in resume source');
      return result as ReturnType<typeof ruleScore>;
    } catch { return ruleScore(resume, job, sourceText); }
  };
}
