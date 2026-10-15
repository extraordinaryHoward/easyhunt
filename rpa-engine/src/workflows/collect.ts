import type { PlatformSkill, SkillContext, Candidate } from '../skills/types.js';
import { ApiError } from '../spec.js';

export type CollectInput = { jobTitle: string; jobRef?: string; keyword: string; city?: string; targetCount: number; maxPages: number };

/* DESIGN-DECISION: 无原始证据，自研 */
// Quick screening is a keyword evidence marker. Initial screening reads details
// for human review; neither stage decides employment eligibility.
export async function collectCandidates(skill: PlatformSkill, ctx: SkillContext, input: CollectInput) {
  if (!input.jobTitle.trim() || !input.keyword.trim()) throw new ApiError(400, 'MISSING_PARAMETER', 'jobTitle and keyword are required');
  if (!Number.isInteger(input.targetCount) || input.targetCount < 1 || input.targetCount > 100) throw new ApiError(400, 'INVALID_PARAMETER', 'targetCount must be 1-100');
  if (!Number.isInteger(input.maxPages) || input.maxPages < 1 || input.maxPages > 20) throw new ApiError(400, 'INVALID_PARAMETER', 'maxPages must be 1-20');
  if (input.jobRef) await skill.jobs.select(ctx, input.jobRef);
  await skill.search.set(ctx, 'keyword', input.keyword);
  if (input.city?.trim()) await skill.search.set(ctx, 'city', input.city.trim());
  await skill.search.apply(ctx, {});
  const seen = new Set<string>();
  const candidates: Array<Candidate & { quickScreen: { keywordMatched: boolean; evidence: string }; initialScreen?: { excerpt?: string; error?: string } }> = [];
  let pagesRead = 0;
  let stopReason = 'target_reached';
  for (let pageNumber = 0; pageNumber < input.maxPages; pageNumber++) {
    const batch = await skill.candidates.list(ctx);
    pagesRead++;
    for (const candidate of batch) {
      if (seen.has(candidate.candidateRef)) continue;
      seen.add(candidate.candidateRef);
      const matched = candidate.summary.toLowerCase().includes(input.keyword.toLowerCase()) || candidate.summary.toLowerCase().includes(input.jobTitle.toLowerCase());
      const record: typeof candidates[number] = { ...candidate, quickScreen: { keywordMatched: matched, evidence: matched ? '列表摘要含岗位或搜索词' : '列表摘要未见岗位或搜索词，待人工复核' } };
      candidates.push(record);
      if (matched) {
        try {
          record.initialScreen = { excerpt: (await skill.resume.read(ctx, candidate.candidateRef)).slice(0, 1500) };
          await skill.resume.close(ctx);
        } catch (error) {
          if (error instanceof ApiError && (error.code === 'RATE_LIMITED' || error.code === 'OPERATION_CANCELLED')) throw error;
          record.initialScreen = { error: error instanceof Error ? error.message : String(error) };
          await skill.resume.close(ctx).catch(() => {});
        }
      }
      if (candidates.length >= input.targetCount) break;
    }
    if (candidates.length >= input.targetCount) break;
    if (pageNumber === input.maxPages - 1) { stopReason = 'page_limit'; break; }
    if (!await skill.candidates.next(ctx)) { stopReason = 'end_of_results'; break; }
  }
  return { jobTitle: input.jobTitle, keyword: input.keyword, targetCount: input.targetCount, collectedCount: candidates.length, pagesRead, stopReason, candidates };
}
