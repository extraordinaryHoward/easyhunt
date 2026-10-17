import { describe, expect, it } from 'vitest';
import { normalizeSearchConfig, previewBossConfig } from './search-config';

describe('BOSS platform configuration', () => {
  it('previews only executable fields in the saved keyword order', () => {
    const config = normalizeSearchConfig({ keywords: ['机器人', '嵌入式'], city: '深圳', company: '示例公司', scenes: { search: true, recommend: true, push: false, review: false } });
    const preview = previewBossConfig(config, '系统工程师');
    expect(preview.valid).toBe(true);
    expect(preview.parameters).toEqual({ jobTitle: '系统工程师', jobRef: undefined, keywords: ['机器人', '嵌入式'], city: '深圳', targetCount: 20, maxPages: 5 });
    expect(preview.unavailable).toContain('公司名称');
    expect(preview.unavailable).toContain('推荐场景');
  });

  it('rejects settings the engine cannot accept', () => {
    expect(previewBossConfig({ keywords: Array.from({ length: 11 }, (_, i) => `词${i}`) }, '岗位').valid).toBe(false);
    expect(previewBossConfig({ enabled: false }, '岗位').blockers).toContain('平台配置已停用');
    expect(previewBossConfig({ platformJobId: 'missing' }, '岗位').blockers).toContain('绑定职位已失效，请重新选择');
    expect(previewBossConfig({ keywords: ['职位'] }, '岗位', [], Number.NaN).valid).toBe(false);
  });

  it('uses the bound BOSS job and deduplicates exactly as the collect request does', () => {
    const preview = previewBossConfig({ platformJobId: 'job-1', keywords: [' 机器人 ', '机器人', '系统'] }, '系统工程师', [{ id: 'job-1', platform: 'boss', platform_job_ref: 'boss-ref-1' }], 40);
    expect(preview.valid).toBe(true);
    expect(preview.parameters).toEqual({ jobTitle: '系统工程师', jobRef: 'boss-ref-1', keywords: ['机器人', '系统'], city: undefined, targetCount: 40, maxPages: 5 });
  });
});
