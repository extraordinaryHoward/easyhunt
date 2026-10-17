export type SceneId = 'search' | 'recommend' | 'push' | 'review';
export const sceneNames: Record<SceneId, string> = { search: '搜索', recommend: '推荐', push: '投递', review: '复聊' };
export const executableScene: SceneId = 'search';
export const unavailableFilters = ['学历', '院校', '经验', '年龄', '薪资', '活跃度', '过滤项'] as const;
export type SearchConfig = { enabled: boolean; platformJobId: string; scenes: Record<SceneId, boolean>; sceneOrder: SceneId[]; keywords: string[]; city: string; company: string };
export type SyncedPlatformJob = { id: string; platform: string; platform_job_ref?: string; platformJobRef?: string };

/* DESIGN-DECISION: 无原始证据，自研 */
// Only the keyword and city paths are wired into the current BOSS collect
// workflow. Preserve other settings without claiming that RPA executes them.
export function normalizeSearchConfig(value: Partial<SearchConfig> = {}): SearchConfig {
  const sceneOrder = [...new Set([...(Array.isArray(value.sceneOrder) ? value.sceneOrder : []), 'search', 'recommend', 'push', 'review'])].filter((item): item is SceneId => typeof item === 'string' && Object.hasOwn(sceneNames, item));
  return { enabled: value.enabled !== false, platformJobId: typeof value.platformJobId === 'string' ? value.platformJobId : '', scenes: { search: true, recommend: false, push: false, review: false, ...value.scenes }, sceneOrder, keywords: (Array.isArray(value.keywords) ? value.keywords : []).filter(word => typeof word === 'string'), city: typeof value.city === 'string' ? value.city : '', company: typeof value.company === 'string' ? value.company : '' };
}
export function previewBossConfig(value: Partial<SearchConfig>, jobTitle: string, jobs: SyncedPlatformJob[] = [], requestedCount = 20) {
  const config = normalizeSearchConfig(value);
  const blockers: string[] = [];
  if (!config.enabled) blockers.push('平台配置已停用');
  if (!config.scenes.search) blockers.push('搜索场景未开启');
  const keywords = [...new Set(config.keywords.map(word => word.trim()).filter(Boolean))];
  if (!keywords.length && !jobTitle.trim()) blockers.push('请填写搜索词或职位名称');
  if (keywords.length > 10) blockers.push('每次最多执行 10 组搜索词');
  if (keywords.some(word => word.length > 80)) blockers.push('搜索词不能超过 80 个字符');
  if (config.city.length > 80) blockers.push('城市不能超过 80 个字符');
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 100) blockers.push('每组快筛数必须为 1–100');
  const linked = config.platformJobId ? jobs.find(job => job.id === config.platformJobId && job.platform === 'boss') : undefined;
  if (config.platformJobId && !linked) blockers.push('绑定职位已失效，请重新选择');
  const jobRef = linked?.platform_job_ref ?? linked?.platformJobRef;
  if (linked && !jobRef) blockers.push('绑定职位缺少平台引用，请重新同步');
  return { valid: blockers.length === 0, blockers, action: 'boss.collect', parameters: { jobTitle: jobTitle.trim(), jobRef: jobRef || undefined, keywords: keywords.length ? keywords : [jobTitle.trim()], city: config.city.trim() || undefined, targetCount: requestedCount, maxPages: 5 }, unavailable: [...(config.company.trim() ? ['公司名称'] : []), ...config.sceneOrder.filter(id => id !== 'search' && config.scenes[id]).map(id => `${sceneNames[id]}场景`)] };
}
