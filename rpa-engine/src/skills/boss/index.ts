import { createHash } from 'node:crypto';
import type { Frame, Locator, Page } from 'playwright';
import { ApiError } from '../../spec.js';
import type { Candidate, Job, PlatformSkill, SkillContext } from '../types.js';
import { bossSelectors } from './selectors.js';

type RefRecord = { sessionRef: string; kind: 'candidate' | 'job'; title?: string; pageNumber?: number };

/* DESIGN-DECISION: 无原始证据，自研 */
export class BossSkill implements PlatformSkill {
  platform = 'boss';
  pages = { search: 'https://www.zhipin.com/web/boss/search/', recommend: 'https://www.zhipin.com/web/boss/recommend/', jobs: 'https://www.zhipin.com/web/chat/job/list' };
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
      if (!/\/web\/(?:boss\/job|chat\/job\/list)/.test(ctx.page.url())) {
        const management = await visible(ctx.page, bossSelectors.job.management);
        if (!management) throw new ApiError(409, 'JOB_MANAGEMENT_NOT_FOUND', `未找到 BOSS「职位管理」入口；当前页面：${ctx.page.url()}`);
        await management.first().click();
        await ctx.page.waitForLoadState('domcontentloaded').catch(() => {});
      }
      let frame: Frame | undefined;
      let firstPage: RawJob[] = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        frame = ctx.page.frames().find(item => bossSelectors.job.frameUrl.test(item.url())) ?? ctx.page.mainFrame();
        firstPage = await readJobRows(frame);
        if (firstPage.length) break;
        await ctx.page.waitForTimeout(250);
      }
      if (!frame || !firstPage.length) throw new ApiError(409, 'DOM_UNRECOGNIZED', `未识别 BOSS 职位管理列表；当前页面：${ctx.page.url()}`);
      const result: Job[] = [];
      const seen = new Set<string>();
      const pagination = await frame.locator('body').innerText().catch(() => '');
      const count = pagination.match(/共\s*(\d+)\s*个职位\s*[\/／]\s*每页\s*(\d+)\s*个/);
      const pages = count ? Math.min(20, Math.ceil(Number(count[1]) / Number(count[2]))) : 1;
      for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
        if (pageNumber > 1) {
          await ctx.step();
          const button = frame.getByRole('button', { name: String(pageNumber), exact: true });
          if (!await button.isVisible().catch(() => false)) throw new ApiError(409, 'PAGINATION_STALLED', `BOSS 职位第 ${pageNumber} 页按钮不可用`);
          const before = firstPage.map(row => row.signature).join('|');
          await button.click();
          let changed = false;
          for (let attempt = 0; attempt < 20; attempt++) {
            await ctx.page.waitForTimeout(200);
            firstPage = await readJobRows(frame);
            if (firstPage.length && firstPage.map(row => row.signature).join('|') !== before) { changed = true; break; }
          }
          if (!changed) throw new ApiError(409, 'PAGINATION_STALLED', `BOSS 职位第 ${pageNumber} 页没有加载`);
        }
        for (const row of firstPage) {
          const jobRef = key('job', row.rawRef);
          if (seen.has(jobRef)) continue;
          seen.add(jobRef);
          this.refs.set(jobRef, { sessionRef: ctx.sessionRef, kind: 'job', title: row.title, pageNumber });
          result.push({ jobRef, title: row.title, ...(row.city ? { city: row.city } : {}), ...(row.status ? { status: row.status } : {}), ...(row.href ? { href: row.href } : {}) });
        }
      }
      return result;
    },
    select: async (ctx: SkillContext, jobRef: string): Promise<void> => {
      await ctx.step();
      this.assertRef(jobRef, ctx.sessionRef, 'job');
      const stored = this.refs.get(jobRef);
      const frame = ctx.page.frames().find(item => bossSelectors.job.frameUrl.test(item.url()));
      if (frame && stored?.title) {
        if (stored.pageNumber) await frame.getByRole('button', { name: String(stored.pageNumber), exact: true }).click();
        const title = frame.getByText(stored.title, { exact: true }).first();
        if (!await title.isVisible().catch(() => false)) throw new ApiError(409, 'JOB_NOT_VISIBLE', 'Job is not on the current page');
        await title.click();
        return;
      }
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

type RawJob = { rawRef: string; title: string; city?: string; status?: string; href?: string; signature: string };

/* DESIGN-DECISION: 无原始证据，自研 */
// Runtime observation showed BOSS rendering the recruiter list inside
// /web/frame/job_v2/list. The exact CSS classes are not stable evidence, so
// prefer job attributes and validate fallback cards by their visible actions.
async function readJobRows(frame: Frame): Promise<RawJob[]> {
  const expression = String.raw`(input) => {
    const { cardSelectors, titleSelectors } = input;
    const textOf = element => element.innerText?.trim() ?? '';
    const eligible = element => {
      const text = textOf(element);
      return Boolean(element.getAttribute('data-job-id') || element.getAttribute('data-jobid')) ||
        (/编辑/.test(text) && /开放中|待开放|已关闭|审核未通过/.test(text));
    };
    const visible = element => !element.hidden && element.getClientRects().length > 0;
    const candidates = new Set();
    for (const selector of cardSelectors) for (const element of document.querySelectorAll(selector)) candidates.add(element);
    let cards = [...candidates].filter(element => visible(element) && eligible(element));
    if (!cards.length) cards = [...document.querySelectorAll('li, article, div')].filter(element => visible(element) && eligible(element));
    const cardSet = new Set(cards);
    cards = cards.filter(element => ![...element.querySelectorAll('*')].some(child => cardSet.has(child)));
    return cards.map(element => {
      const signature = textOf(element);
      const lines = signature.split('\n').map(line => line.trim()).filter(Boolean);
      const titleNode = titleSelectors.map(selector => element.querySelector(selector)).find(Boolean);
      const title = (titleNode ? textOf(titleNode) : lines[0] ?? '').replace(/(?:\s+(?:普|竞|匿名))+$/, '').trim();
      const city = signature.match(/(?:北京|上海|深圳|广州|杭州|成都|武汉|南京|苏州|西安|重庆|天津|长沙|厦门|青岛|郑州|合肥|东莞|佛山|宁波|无锡|济南|福州|大连|昆明|沈阳|珠海)/)?.[0];
      const status = signature.match(/开放中|待开放|已关闭|审核未通过/)?.[0];
      const href = element.querySelector('a[href*="job"]')?.getAttribute('href') ?? undefined;
      const id = element.getAttribute('data-job-id') ?? element.getAttribute('data-jobid') ?? element.querySelector('[data-job-id],[data-jobid]')?.getAttribute('data-job-id') ?? undefined;
      const salary = signature.match(/\d+\s*-\s*\d+K(?:·\d+薪)?/)?.[0] ?? '';
      const company = lines.find(line => line !== title && !/^(?:北京|上海|深圳|广州|杭州|成都|武汉|南京|苏州|西安|重庆|天津|长沙|厦门|青岛|郑州|合肥|东莞|佛山|宁波|无锡|济南|福州|大连|昆明|沈阳|珠海)$/.test(line)) ?? '';
      return { rawRef: id ?? href ?? (title + '|' + company + '|' + (city ?? '') + '|' + salary), title, city, status, href, signature };
    }).filter(row => row.title && !/^(?:全部|开放中|待开放|已关闭|审核未通过)$/.test(row.title));
  }`;
  const input = JSON.stringify({ cardSelectors: bossSelectors.job.card, titleSelectors: bossSelectors.job.title });
  return await frame.evaluate(`(${expression})(${input})`) as RawJob[];
}
