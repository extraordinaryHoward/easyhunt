export type SceneId = 'search' | 'recommend' | 'push' | 'review';
export const sceneNames: Record<SceneId, string> = { search: '搜索', recommend: '推荐', push: '投递', review: '复聊' };
export const executableScene: SceneId = 'search';
export const unavailableFilters = ['学历', '院校', '经验', '年龄', '薪资', '活跃度', '过滤项'] as const;
export type SearchConfig = { enabled: boolean; platformJobId: string; scenes: Record<SceneId, boolean>; sceneOrder: SceneId[]; keywords: string[]; city: string; company: string };

/* DESIGN-DECISION: 无原始证据，自研 */
// Only the keyword and city paths are wired into the current BOSS collect
// workflow. Preserve other settings without claiming that RPA executes them.
export function normalizeSearchConfig(value: Partial<SearchConfig> = {}): SearchConfig {
  const sceneOrder = [...new Set([...(value.sceneOrder ?? []), 'search', 'recommend', 'push', 'review'])].filter((item): item is SceneId => item in sceneNames);
  return { enabled: value.enabled !== false, platformJobId: value.platformJobId ?? '', scenes: { search: true, recommend: false, push: false, review: false, ...value.scenes }, sceneOrder, keywords: (value.keywords ?? []).filter(word => typeof word === 'string'), city: value.city ?? '', company: value.company ?? '' };
}
export function previewBossConfig(value: Partial<SearchConfig>, jobTitle: string) {
  const config = normalizeSearchConfig(value);
  const blockers: string[] = [];
  if (!config.enabled) blockers.push('平台配置已停用');
  if (!config.scenes.search) blockers.push('搜索场景未开启');
  const keywords = [...new Set(config.keywords.map(word => word.trim()).filter(Boolean))];
  if (!keywords.length && !jobTitle.trim()) blockers.push('请填写搜索词或职位名称');
  if (keywords.length > 10) blockers.push('每次最多执行 10 组搜索词');
  if (keywords.some(word => word.length > 80)) blockers.push('搜索词不能超过 80 个字符');
  if (config.city.length > 80) blockers.push('城市不能超过 80 个字符');
  return { valid: blockers.length === 0, blockers, action: 'boss.collect', parameters: { keywords: keywords.length ? keywords : [jobTitle.trim()], city: config.city.trim() || undefined, platformJobId: config.platformJobId || undefined }, unavailable: [...(config.company.trim() ? ['公司名称'] : []), ...config.sceneOrder.filter(id => id !== 'search' && config.scenes[id]).map(id => `${sceneNames[id]}场景`)] };
}
