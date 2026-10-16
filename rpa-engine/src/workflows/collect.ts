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
  ctx.report?.('browser.ready', '平台浏览器已连接');
  const currentUrl = ctx.page.url();
  if (/login|\/web\/user/i.test(currentUrl)) {
    ctx.report?.('login.required', '等待在独立浏览器完成平台登录');
    throw new ApiError(409, 'LOGIN_REQUIRED', '请先在独立浏览器完成 BOSS 招聘账号登录，再重新启动任务');
  }
  ctx.report?.('login.checked', '已检查当前平台页面');
  ctx.report?.('search.prepare', `准备搜索「${input.keyword}」`, { keyword: input.keyword, targetCount: input.targetCount });
  if (input.jobRef) await skill.jobs.select(ctx, input.jobRef, input.jobTitle);
  await skill.search.set(ctx, 'keyword', input.keyword);
  if (input.city?.trim()) await skill.search.set(ctx, 'city', input.city.trim());
  await skill.search.apply(ctx, {});
  ctx.report?.('search.started', '搜索条件已应用');
  const seen = new Set<string>();
  const candidates: Array<Candidate & { quickScreen: { keywordMatched: boolean; evidence: string }; initialScreen?: { excerpt?: string; error?: string } }> = [];
  let pagesRead = 0;
  let stopReason = 'target_reached';
  for (let pageNumber = 0; pageNumber < input.maxPages; pageNumber++) {
    const batch = await skill.candidates.list(ctx);
    pagesRead++;
    ctx.report?.('search.page', `第 ${pagesRead} 页读取 ${batch.length} 人`, { pagesRead, pageCount: batch.length, collectedCount: candidates.length });
    for (const candidate of batch) {
      if (seen.has(candidate.candidateRef)) continue;
      seen.add(candidate.candidateRef);
      const matched = candidate.summary.toLowerCase().includes(input.keyword.toLowerCase()) || candidate.summary.toLowerCase().includes(input.jobTitle.toLowerCase());
      const record: typeof candidates[number] = { ...candidate, quickScreen: { keywordMatched: matched, evidence: matched ? '列表摘要含岗位或搜索词' : '列表摘要未见岗位或搜索词，待人工复核' } };
      candidates.push(record);
      ctx.report?.('candidate.quick', `已快筛 ${candidates.length} 人`, { collectedCount: candidates.length, candidateRef: candidate.candidateRef });
      if (matched) {
        try {
          record.initialScreen = { excerpt: (await skill.resume.read(ctx, candidate.candidateRef)).slice(0, 1500) };
          await skill.resume.close(ctx);
          ctx.report?.('candidate.initial', `已初筛 ${candidates.filter(item => item.initialScreen?.excerpt).length} 人`, { initialCount: candidates.filter(item => item.initialScreen?.excerpt).length });
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
  ctx.report?.('search.completed', `搜索完成，采集 ${candidates.length} 人`, { collectedCount: candidates.length, pagesRead, stopReason });
  return { jobTitle: input.jobTitle, keyword: input.keyword, targetCount: input.targetCount, collectedCount: candidates.length, pagesRead, stopReason, candidates };
}
