import { createHash } from 'node:crypto';
import type { Locator, Page } from 'playwright';
import { ApiError } from '../../spec.js';
import type { Candidate, Job, PlatformSkill, SkillContext } from '../types.js';
import { bossSelectors } from './selectors.js';

type RefRecord = { sessionRef: string; kind: 'candidate' | 'job' };

/* DESIGN-DECISION: 无原始证据，自研 */
export class BossSkill implements PlatformSkill {
  platform = 'boss';
  pages = { search: 'https://www.zhipin.com/web/boss/search/', recommend: 'https://www.zhipin.com/web/boss/recommend/' };
  private refs = new Map<string, RefRecord>();
  private opened = new Map<string, string>();

  search = {
    fields: async (ctx: SkillContext): Promise<string[]> => {
      await ctx.step();
      const found: string[] = [];
      for (const field of ['keyword', 'city', 'experience', 'education'] as const) {
        if (await visible(ctx.page, bossSelectors.search[field])) found.push(field);
      }
      return found;
    },
    get: async (ctx: SkillContext, field: string): Promise<unknown> => {
      await ctx.step();
      const control = await this.field(ctx.page, field);
      return control.first().inputValue().catch(() => control.first().innerText());
    },
    set: async (ctx: SkillContext, field: string, value: unknown): Promise<void> => {
      await ctx.step();
      if (typeof value !== 'string' && typeof value !== 'number') throw new ApiError(400, 'INVALID_PARAMETER', `${field} must be text or number`);
      const control = await this.field(ctx.page, field);
      await control.first().fill(String(value));
    },
    apply: async (ctx: SkillContext, patch: Record<string, unknown>): Promise<void> => {
      for (const [field, value] of Object.entries(patch)) await this.search.set(ctx, field, value);
      await ctx.step();
      const submit = await visible(ctx.page, bossSelectors.search.submit);
      if (submit) await submit.first().click();
      else await (await this.field(ctx.page, 'keyword')).first().press('Enter');
    }
  };

  candidates = {
    list: async (ctx: SkillContext): Promise<Candidate[]> => {
      await ctx.step();
      this.requireCandidatePage(ctx.page);
      const cards = await visible(ctx.page, bossSelectors.candidate.card);
      if (!cards) throw new ApiError(409, 'DOM_UNRECOGNIZED', `Candidate cards not recognized at ${ctx.page.url()}`);
      const result: Candidate[] = [];
      for (const card of (await cards.all()).slice(0, 50)) {
        const summary = (await card.innerText().catch(() => '')).trim();
        if (!summary) continue;
        const rawRef = await card.getAttribute('data-candidate-id') ?? await optionalHref(card) ?? summary;
        const candidateRef = key('candidate', rawRef);
        const nameLocator = await visible(card, bossSelectors.candidate.name);
        const name = (nameLocator ? await nameLocator.innerText() : summary.split('\n')[0]).trim();
        const href = await optionalHref(card);
        this.refs.set(candidateRef, { sessionRef: ctx.sessionRef, kind: 'candidate' });
        result.push({ candidateRef, name, summary: summary.slice(0, 500), ...(href ? { href } : {}) });
      }
      return result;
    },
    next: async (ctx: SkillContext): Promise<boolean> => {
      await ctx.step();
      this.requireCandidatePage(ctx.page);
      const button = await visible(ctx.page, bossSelectors.candidate.next);
      if (!button || await button.first().isDisabled()) return false;
      const old = await this.firstCardText(ctx.page);
      await button.first().click();
      for (let attempt = 0; attempt < 20; attempt++) {
        await ctx.step();
        if ((await this.firstCardText(ctx.page)) !== old) return true;
        await ctx.page.waitForTimeout(150);
      }
      throw new ApiError(409, 'PAGINATION_STALLED', 'Candidate page did not change after next');
    }
  };

  resume = {
    open: async (ctx: SkillContext, candidateRef: string): Promise<void> => {
      await ctx.step();
      this.assertRef(candidateRef, ctx.sessionRef, 'candidate');
      if (await visible(ctx.page, bossSelectors.candidate.detail)) await this.resume.close(ctx);
      const card = await this.findCard(ctx.page, bossSelectors.candidate.card, candidateRef, 'candidate');
      if (!card) throw new ApiError(409, 'CANDIDATE_NOT_VISIBLE', 'Candidate is not on the current page');
      await card.click();
      const detail = await visible(ctx.page, bossSelectors.candidate.detail);
      if (!detail) throw new ApiError(409, 'DOM_UNRECOGNIZED', 'Resume detail did not open');
      this.opened.set(ctx.sessionRef, candidateRef);
    },
    read: async (ctx: SkillContext, candidateRef: string): Promise<string> => {
      let detail = await visible(ctx.page, bossSelectors.candidate.detail);
      if (!detail || this.opened.get(ctx.sessionRef) !== candidateRef) { await this.resume.open(ctx, candidateRef); detail = await visible(ctx.page, bossSelectors.candidate.detail); }
      await ctx.step();
      if (!detail) throw new ApiError(409, 'DOM_UNRECOGNIZED', 'Resume detail not found');
      return (await detail.first().innerText()).slice(0, 20000);
    },
    close: async (ctx: SkillContext): Promise<void> => {
      await ctx.step();
      const button = await visible(ctx.page, bossSelectors.candidate.close);
      if (button) await button.first().click();
      else await ctx.page.keyboard.press('Escape');
      this.opened.delete(ctx.sessionRef);
    }
  };

  jobs = {
    list: async (ctx: SkillContext): Promise<Job[]> => {
      await ctx.step();
      if (/\/web\/user|login/i.test(ctx.page.url())) throw new ApiError(409, 'LOGIN_REQUIRED', '请先在 BOSS 浏览器登录招聘账号');
      /* DESIGN-DECISION: 无原始证据，自研 */
      // BOSS frequently redirects the search URL to its chat home. Navigate through
      // the visible recruiter menu so the DOM is read from the actual job manager.
      const management = await visible(ctx.page, bossSelectors.job.management);
      if (management) {
        await management.first().click();
        await ctx.page.waitForLoadState('domcontentloaded').catch(() => {});
      } else if (!/\/web\/boss\/job/.test(ctx.page.url())) {
        throw new ApiError(409, 'JOB_MANAGEMENT_NOT_FOUND', `未找到 BOSS「职位管理」入口；当前页面：${ctx.page.url()}`);
      }
      let cards: Locator | undefined;
      for (let attempt = 0; attempt < 20; attempt++) {
        cards = await visible(ctx.page, bossSelectors.job.card);
        if (cards) break;
        await ctx.page.waitForTimeout(250);
      }
      if (!cards) throw new ApiError(409, 'DOM_UNRECOGNIZED', `未识别 BOSS 职位管理列表；当前页面：${ctx.page.url()}`);
      const result: Job[] = [];
      for (const card of (await cards.all()).slice(0, 50)) {
        const titleLocator = await visible(card, bossSelectors.job.title);
        const rawText = (await card.innerText().catch(() => '')).trim();
        const title = ((titleLocator ? await titleLocator.innerText() : rawText) ?? '').trim().split('\n')[0];
        if (!title) continue;
        const href = await optionalHref(card);
        const rawRef = await card.getAttribute('data-job-id') ?? await card.getAttribute('data-jobid') ?? href ?? `${title}:${rawText}`;
        const jobRef = key('job', rawRef);
        this.refs.set(jobRef, { sessionRef: ctx.sessionRef, kind: 'job' });
        const city = rawText.match(/(?:北京|上海|深圳|广州|杭州|成都|武汉|南京|苏州|西安|重庆|天津|长沙|厦门|青岛|郑州|合肥|东莞|佛山|宁波|无锡|济南|福州|大连|昆明|沈阳|珠海)/)?.[0];
        result.push({ jobRef, title, ...(city ? { city } : {}), ...(href ? { href } : {}) });
      }
      return result;
    },
    select: async (ctx: SkillContext, jobRef: string): Promise<void> => {
      await ctx.step();
      this.assertRef(jobRef, ctx.sessionRef, 'job');
      const card = await this.findCard(ctx.page, bossSelectors.job.card, jobRef, 'job');
      if (!card) throw new ApiError(409, 'JOB_NOT_VISIBLE', 'Job is not on the current page');
      const button = await visible(card, bossSelectors.job.select);
      if (button) await button.first().click(); else await card.click();
    }
  };

  resolveSessionRef(ref: string): string | undefined { return this.refs.get(ref)?.sessionRef; }

  private async field(page: Page, field: string): Promise<Locator> {
    const selectors = bossSelectors.search[field as keyof typeof bossSelectors.search];
    if (!selectors || field === 'submit') throw new ApiError(400, 'UNSUPPORTED_FIELD', `Unsupported search field: ${field}`);
    const control = await visible(page, selectors);
    if (!control) throw new ApiError(409, 'DOM_UNRECOGNIZED', `Search field not found: ${field}`);
    return control;
  }
  private requireCandidatePage(page: Page) {
    if (/\/web\/user|login/i.test(page.url())) throw new ApiError(409, 'LOGIN_REQUIRED', 'BOSS login required');
    if (!/zhipin\.com\/web\/(boss\/(search|recommend)|chat\/search)/.test(page.url())) throw new ApiError(409, 'UNEXPECTED_PAGE', `Not on a BOSS candidate page: ${page.url()}`);
  }
  private assertRef(ref: string, sessionRef: string, kind: RefRecord['kind']) {
    const item = this.refs.get(ref);
    if (!item || item.sessionRef !== sessionRef || item.kind !== kind) throw new ApiError(404, 'REFERENCE_NOT_FOUND', `${kind} reference not found in session`);
  }
  private async firstCardText(page: Page) {
    const cards = await visible(page, bossSelectors.candidate.card);
    return cards ? (await cards.first().innerText().catch(() => '')) : '';
  }
  private async findCard(page: Page, selectors: readonly string[], ref: string, kind: RefRecord['kind']) {
    const cards = await visible(page, selectors);
    if (!cards) return undefined;
    for (const card of await cards.all()) {
      const text = (await card.innerText().catch(() => '')).trim();
      const id = await card.getAttribute(kind === 'candidate' ? 'data-candidate-id' : 'data-job-id') ?? (kind === 'job' ? await card.getAttribute('data-jobid') : null);
      const href = await optionalHref(card);
      if (key(kind, id ?? href ?? (kind === 'job' ? `${text.split('\n')[0]}:${text}` : text)) === ref) return card;
    }
    return undefined;
  }
}

async function visible(root: Page | Locator, selectors: readonly string[]): Promise<Locator | undefined> {
  for (const selector of selectors) {
    const locator = root.locator(selector);
    if (await locator.first().isVisible().catch(() => false)) return locator;
  }
  return undefined;
}
function key(kind: string, value: string) { return `${kind}-${createHash('sha256').update(value).digest('hex').slice(0, 20)}`; }
async function optionalHref(card: Locator) {
  const link = card.locator('a[href]').first();
  return await link.count() ? link.getAttribute('href') : null;
}
