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
      ctx.report?.('jobs.open', '正在读取 BOSS 职位管理');
      if (/\/web\/user|login/i.test(ctx.page.url())) {
        ctx.report?.('login.required', '请在独立 BOSS 浏览器完成登录，登录后自动继续同步');
        /* DESIGN-DECISION: 无原始证据，自研 */
        // Wait for the human to finish the platform login; this never fills a
        // password, scans a QR code, or bypasses the platform login UI.
        for (let attempt = 0; attempt < 120 && /\/web\/user|login/i.test(ctx.page.url()); attempt++) {
          await ctx.checkpoint?.();
          await ctx.page.waitForTimeout(1000);
        }
        if (/\/web\/user|login/i.test(ctx.page.url())) throw new ApiError(409, 'LOGIN_REQUIRED', '等待登录超时；请在独立 BOSS 浏览器登录后重新同步');
        ctx.report?.('login.checked', 'BOSS 登录页面已关闭，继续读取职位');
      }
      /* DESIGN-DECISION: 无原始证据，自研 */
      // BOSS frequently redirects the search URL to its chat home. Navigate through
      // the visible recruiter menu so the DOM is read from the actual job manager.
      if (!/\/web\/(?:boss\/job|chat\/job\/list)/.test(ctx.page.url())) {
        const management = await visible(ctx.page, bossSelectors.job.management);
        if (!management) throw new ApiError(409, 'JOB_MANAGEMENT_NOT_FOUND', `未找到 BOSS「职位管理」入口；当前页面：${ctx.page.url()}`);
        await management.first().click();
        await ctx.page.waitForLoadState('domcontentloaded').catch(() => {});
      }
      const currentFrame = () => ctx.page.frames().find(item => bossSelectors.job.frameUrl.test(item.url())) ?? ctx.page.mainFrame();
      const readCurrentRows = async (): Promise<RawJob[]> => {
        for (let retry = 0; retry < 5; retry++) {
          try { return await readJobRows(currentFrame()); }
          catch (error) {
            if (!isDetachedFrame(error) || retry === 4) throw error;
            await ctx.page.waitForTimeout(150);
          }
        }
        return [];
      };
      let firstPage: RawJob[] = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        await ctx.checkpoint?.();
        firstPage = await readCurrentRows();
        if (firstPage.length) break;
        await ctx.page.waitForTimeout(250);
      }
      if (!firstPage.length) throw new ApiError(409, 'DOM_UNRECOGNIZED', `未识别 BOSS 职位管理列表；当前页面：${ctx.page.url()}`);
      const result: Job[] = [];
      const seen = new Set<string>();
      const pagination = await currentFrame().locator('body').innerText().catch(() => '');
      const count = pagination.match(/共\s*(\d+)\s*个职位\s*[\/／]\s*每页\s*(\d+)\s*个/);
      const pageLimit = 100;
      const knownPages = count && Number(count[2]) > 0 ? Math.ceil(Number(count[1]) / Number(count[2])) : undefined;
      if (knownPages && knownPages > pageLimit) throw new ApiError(409, 'JOB_PAGE_LIMIT', `BOSS 职位共有 ${knownPages} 页，超过本次 ${pageLimit} 页读取上限；请联系支持人员，不会保存部分职位`);
      const pages = knownPages ?? pageLimit;
      let completedPages = 0;
      for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
        if (pageNumber > 1) {
          await ctx.step();
          const button = currentFrame().getByRole('button', { name: String(pageNumber), exact: true });
          if (!await button.isVisible().catch(() => false) || !await button.isEnabled().catch(() => false)) {
            if (!count) break;
            throw new ApiError(409, 'PAGINATION_STALLED', `BOSS 职位第 ${pageNumber} 页按钮不可用，已读 ${result.length} 个职位`);
          }
          const before = firstPage.map(row => row.signature).join('|');
          await button.click();
          let changed = false;
          for (let attempt = 0; attempt < 20; attempt++) {
            await ctx.checkpoint?.();
            await ctx.page.waitForTimeout(200);
            firstPage = await readCurrentRows();
            if (firstPage.length && firstPage.map(row => row.signature).join('|') !== before) { changed = true; break; }
          }
          if (!changed) throw new ApiError(409, 'PAGINATION_STALLED', `BOSS 职位第 ${pageNumber} 页没有加载，已读 ${result.length} 个职位`);
        }
        for (const row of firstPage) {
          const jobRef = key('job', row.rawRef);
          if (seen.has(jobRef)) continue;
          seen.add(jobRef);
          this.refs.set(jobRef, { sessionRef: ctx.sessionRef, kind: 'job', title: row.title, pageNumber });
          result.push({ jobRef, title: row.title, ...(row.city ? { city: row.city } : {}), ...(row.status ? { status: row.status } : {}), ...(row.href ? { href: row.href } : {}) });
        }
        completedPages = pageNumber;
        if (result.length > 500) throw new ApiError(409, 'JOB_COUNT_LIMIT', 'BOSS 职位超过 500 个，本次没有保存部分职位；请联系支持人员');
        ctx.report?.('jobs.page', `已读取第 ${pageNumber}${knownPages ? `/${knownPages}` : ''} 页，共 ${result.length} 个职位`, { pageNumber, ...(knownPages ? { pages: knownPages } : {}), count: result.length });
      }
      if (!knownPages && completedPages === pageLimit && await currentFrame().getByRole('button', { name: String(pageLimit + 1), exact: true }).isVisible().catch(() => false)) throw new ApiError(409, 'JOB_PAGE_LIMIT', `BOSS 职位超过 ${pageLimit} 页，本次没有保存部分职位；请联系支持人员`);
      ctx.report?.('jobs.completed', `职位读取完成，共 ${result.length} 个`, { count: result.length, pages: completedPages });
      return result;
    },
    select: async (ctx: SkillContext, jobRef: string, fallbackTitle?: string): Promise<void> => {
      await ctx.step();
      const stored = this.refs.get(jobRef);
      if (stored && (stored.sessionRef !== ctx.sessionRef || stored.kind !== 'job')) throw new ApiError(404, 'REFERENCE_NOT_FOUND', 'Job reference belongs to another session');
      const title = stored?.title ?? fallbackTitle;
      if (!title) throw new ApiError(404, 'REFERENCE_NOT_FOUND', 'Job title is needed to select a synchronized position');
      if (/\/web\/(boss\/(search|recommend)|chat\/search)/.test(ctx.page.url())) {
        const picker = await visible(ctx.page, bossSelectors.job.picker);
        if (picker) {
          await picker.first().click();
          const option = ctx.page.getByText(title, { exact: true }).last();
          if (await option.isVisible().catch(() => false)) { await option.click(); return; }
        }
      }
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
    },
    description: async (ctx: SkillContext, jobRef: string, title: string): Promise<string> => {
      /* DESIGN-DECISION: 无原始证据，自研 */
      // The reference UI offers JD sync, but its bytecode does not reveal the read path.
      // Open the visible job editor for reading only; never press save or publish.
      await ctx.step();
      ctx.report?.('jobs.description', `正在读取「${title}」的职位描述`);
      if (!/\/web\/(?:boss\/job|chat\/job\/list)/.test(ctx.page.url())) await ctx.page.goto(this.pages.jobs, { waitUntil: 'domcontentloaded' });
      for (let pageNumber = 1; pageNumber <= 20; pageNumber++) {
        await ctx.step();
        let frame: Frame | undefined;
        let rows: RawJob[] = [];
        for (let attempt = 0; attempt < 20; attempt++) {
          frame = ctx.page.frames().find(item => bossSelectors.job.frameUrl.test(item.url())) ?? ctx.page.mainFrame();
          try { rows = await readJobRows(frame); } catch (error) { if (!isDetachedFrame(error)) throw error; }
          if (rows.length) break;
          await ctx.page.waitForTimeout(200);
        }
        if (!frame || !rows.length) throw new ApiError(409, 'JOB_MANAGEMENT_NOT_FOUND', '未找到 BOSS 职位列表，请登录并打开职位管理');
        const match = rows.find(row => key('job', row.rawRef) === jobRef) ?? rows.find(row => row.title === title);
        if (match) {
          const card = frame.getByText(match.title, { exact: true }).first().locator('xpath=ancestor::*[.//button[contains(normalize-space(.),"编辑")]][1]');
          const editor = card.getByRole('button', { name: /编辑/ }).first();
          if (!await editor.isVisible().catch(() => false)) throw new ApiError(409, 'JD_NOT_FOUND', '职位编辑入口不可见，请改用粘贴 JD');
          await editor.click();
          for (let attempt = 0; attempt < 25; attempt++) {
            await ctx.checkpoint?.();
            for (const current of ctx.page.frames()) {
              try {
                const value = await readJobDescription(current);
                if (value) { ctx.report?.('jobs.description.ready', '已读取职位描述', { count: value.length }); return value; }
              } catch (error) { if (!isDetachedFrame(error)) throw error; }
            }
            await ctx.page.waitForTimeout(200);
          }
          throw new ApiError(409, 'JD_NOT_FOUND', '未识别到已发布职位的 JD，请改用粘贴 JD');
        }
        const next = frame.getByRole('button', { name: String(pageNumber + 1), exact: true });
        if (!await next.isVisible().catch(() => false)) break;
        await next.click();
      }
      throw new ApiError(404, 'JOB_NOT_FOUND', `未找到职位「${title}」，请重新同步职位或粘贴 JD`);
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
function isDetachedFrame(error: unknown): boolean {
  return error instanceof Error && /Frame was detached|Execution context was destroyed/i.test(error.message);
}

async function readJobDescription(frame: Frame): Promise<string> {
  const expression = String.raw`() => {
    const selectors = [
      'textarea[name*="description" i]', 'textarea[placeholder*="职位描述"]',
      'textarea[placeholder*="职位要求"]', '[contenteditable="true"]',
      '.ql-editor', '.job-description', '[data-testid="job-description"]'
    ];
    for (const selector of selectors) for (const element of document.querySelectorAll(selector)) {
      if (!element.getClientRects().length) continue;
      const text = ('value' in element ? element.value : element.innerText || element.textContent || '').trim();
      if (text.length >= 30) return text;
    }
    return '';
  }`;
  return await frame.evaluate(`(${expression})()`) as string;
}

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
