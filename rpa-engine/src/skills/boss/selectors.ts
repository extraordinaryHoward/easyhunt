/* DESIGN-DECISION: 无原始证据，自研 */
// Ordered fallbacks. The protected main-process bytecode supplies no verified DOM selectors.
// Keep all BOSS markup assumptions here so a site redesign changes one file.
export const bossSelectors = {
  search: {
    keyword: ['input[placeholder*="搜索人才"]', 'input[placeholder*="搜索"]', 'input[name="keyword"]', '[data-testid="search-keyword"] input'],
    city: ['[data-filter-key="city"] input', 'input[name="city"]'],
    experience: ['[data-filter-key="experience"] input', 'input[name="experience"]'],
    education: ['[data-filter-key="education"] input', 'input[name="education"]'],
    submit: ['button:has-text("搜索")', '[data-testid="search-submit"]', 'button[type="submit"]']
  },
  candidate: {
    card: ['[data-candidate-id]', '.candidate-item', '.geek-item'],
    name: ['[data-testid="candidate-name"]', '.name', '.geek-name', 'h3'],
    detail: ['[data-testid="resume-detail"]', '.resume-detail', '[role="dialog"]', '.detail-container'],
    close: ['[data-testid="resume-close"]', '[role="dialog"] button[aria-label*="关闭"]', '.resume-detail .close'],
    next: ['button:has-text("下一页")', 'a:has-text("下一页")', '[aria-label="下一页"]', '[data-testid="next-page"]']
  },
  job: {
    frameUrl: /\/web\/frame\/job_v2\/list/,
    management: ['a:has-text("职位管理")', '[role="menuitem"]:has-text("职位管理")', 'nav :text-is("职位管理")', ':text-is("职位管理")'],
    picker: ['[role="combobox"]:has-text("职位")', 'button:has-text("选择职位")', '.job-select', '[data-testid="job-picker"]'],
    card: ['[data-job-id]', '[data-jobid]', '.job-list .job-item', '.job-card', '.job-list tbody tr', 'table tbody tr'],
    title: ['[data-testid="job-title"]', '.job-title', 'a[href*="job"]', 'h3', 'td:first-child'],
    select: ['button:has-text("选择")', 'button:has-text("绑定")', '[data-testid="select-job"]']
  }
} as const;
