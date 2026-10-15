import { z } from 'zod';
import { ApiError } from '../errors.js';
import { LlmClient, type ChatMessage } from './client.js';
import { prompt } from './prompts.js';

const evidenceItem = z.strictObject({ content: z.string().min(1), evidence: z.array(z.string().min(1)) });
const profileItem = z.strictObject({ content: z.string().min(1), evidence: z.array(z.string().min(1)).min(1) });
export const ProfileSchema = z.strictObject({ hardConditions: z.array(profileItem), businessConditions: z.array(profileItem), bonusItems: z.array(profileItem) });
export const ScoreSchema = z.strictObject({ stars: z.number().int().min(1).max(5), score: z.number().int().min(0).max(100), analysis: z.strictObject({ matched: z.array(evidenceItem), mismatched: z.array(evidenceItem), pending: z.array(evidenceItem) }) });
export const TermsSchema = z.strictObject({ terms: z.array(z.strictObject({ keyword: z.string().trim().min(1).max(100) })).min(1).max(3), reason: z.string().min(1) });
export const ResumeExtractSchema = z.object({ name: z.string().min(1).max(100), phone: z.string().optional(), email: z.email().optional(), wechat: z.string().optional(), expectedCity: z.string().optional(), expectedTitle: z.string().optional(), expectedSalary: z.object({ min: z.number(), max: z.number(), unit: z.literal('K/月'), months: z.number().optional() }).optional(), expectedSalaryText: z.string().optional(), skills: z.array(z.string().min(1)).min(1), workExperiences: z.array(z.object({ company: z.string(), title: z.string(), startDate: z.string().optional(), endDate: z.string().optional(), description: z.string().optional() })), educationExperiences: z.array(z.object({ school: z.string(), degree: z.string(), major: z.string().optional(), startDate: z.string().optional(), endDate: z.string().optional() })), totalExperienceYears: z.number().optional(), currentCity: z.string().optional(), industry: z.string().optional() });

function parseJson<T extends z.ZodType>(raw: string, schema: T): z.infer<T> {
  try { return schema.parse(JSON.parse(raw)); }
  catch { throw new ApiError(502, 'LLM_INVALID_RESPONSE', 'LLM response does not match the required schema'); }
}
function checkEvidence(items: Array<{ evidence: string[] }>, source: string) {
  for (const item of items) for (const excerpt of item.evidence) if (!source.includes(excerpt)) throw new ApiError(502, 'LLM_EVIDENCE_INVALID', 'LLM evidence was not found in source text');
}

export class LlmService {
  constructor(private client: LlmClient) {}
  async chat(accountId: string, messages: ChatMessage[]) { return this.client.chat(accountId, messages); }
  async profile(accountId: string, jd: string) {
    const template = await prompt('profile');
    const result = parseJson(await this.client.chat(accountId, [{ role: 'system', content: template.content }, { role: 'user', content: jd }], true), ProfileSchema);
    checkEvidence([...result.hardConditions, ...result.businessConditions, ...result.bonusItems], jd);
    return { profile: result, promptVersion: template.version };
  }
  async score(accountId: string, job: unknown, resume: unknown, sourceText: string) {
    const template = await prompt('resumeScore');
    const result = parseJson(await this.client.chat(accountId, [{ role: 'system', content: template.content }, { role: 'user', content: JSON.stringify({ job, resume, sourceText }) }], true), ScoreSchema);
    checkEvidence([...result.analysis.matched, ...result.analysis.mismatched, ...result.analysis.pending], sourceText);
    return { result, promptVersion: template.version };
  }
  async terms(accountId: string, profile: unknown, previousRounds: unknown[]) {
    const template = await prompt('searchTerms');
    const result = parseJson(await this.client.chat(accountId, [{ role: 'system', content: template.content }, { role: 'user', content: JSON.stringify({ profile, previousRounds }) }], true), TermsSchema);
    return { ...result, promptVersion: template.version };
  }
  async extract(accountId: string, sourceText: string) {
    const template = await prompt('resumeExtract');
    const resume = parseJson(await this.client.chat(accountId, [{ role: 'system', content: template.content }, { role: 'user', content: sourceText }], true), ResumeExtractSchema);
    return { resume, promptVersion: template.version };
  }
}
