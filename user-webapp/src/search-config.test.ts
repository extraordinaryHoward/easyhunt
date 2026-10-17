import { describe, expect, it } from 'vitest';
import { normalizeSearchConfig, previewBossConfig } from './search-config';

describe('BOSS platform configuration', () => {
  it('previews only executable fields in the saved keyword order', () => {
    const config = normalizeSearchConfig({ keywords: ['机器人', '嵌入式'], city: '深圳', company: '示例公司', scenes: { search: true, recommend: true, push: false, review: false } });
    const preview = previewBossConfig(config, '系统工程师');
    expect(preview.valid).toBe(true);
    expect(preview.parameters).toEqual({ keywords: ['机器人', '嵌入式'], city: '深圳', platformJobId: undefined });
    expect(preview.unavailable).toContain('公司名称');
    expect(preview.unavailable).toContain('推荐场景');
  });

  it('rejects settings the engine cannot accept', () => {
    expect(previewBossConfig({ keywords: Array.from({ length: 11 }, (_, i) => `词${i}`) }, '岗位').valid).toBe(false);
    expect(previewBossConfig({ enabled: false }, '岗位').blockers).toContain('平台配置已停用');
  });
});
