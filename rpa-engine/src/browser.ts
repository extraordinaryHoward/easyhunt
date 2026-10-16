import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { ApiError } from './spec.js';
import { SkillRegistry } from './skills/registry.js';

export type Platform = 'boss' | 'liepin' | 'liepin_enterprise';
type Session = { sessionRef: string; platform: Platform | null; paused: boolean; page: Page; waiters: Set<() => void>; lastActionAt: number };

export class BrowserManager {
  private browser?: Browser;
  private context?: BrowserContext;
  private embeddedPage?: Page;
  private embeddedTargetId?: string;
  private sessions = new Map<string, Session>();
  constructor(private options: { cdpUrl?: string; headless?: boolean; minIntervalMs?: number; executablePath?: string; skills?: SkillRegistry } = {}) {}

  registerEmbeddedTarget(targetId: string) {
    if (!/^[a-f\d]{32}$/i.test(targetId)) throw new ApiError(400, 'INVALID_TARGET_ID', 'Invalid BrowserView CDP targetId');
    if (this.embeddedTargetId && this.embeddedTargetId !== targetId) {
      this.embeddedPage = undefined;
      for (const session of this.sessions.values()) for (const wake of session.waiters) wake();
      this.sessions.clear();
    }
    this.embeddedTargetId = targetId;
    return { registered: true };
  }

  async open(input: { platform?: Platform; page?: string; jobId?: string }) {
    const platform = input.platform ?? null;
    const pageKind = input.page ?? 'search';
    const pageUrl = platform ? (this.options.skills ?? new SkillRegistry()).get(platform).pages[pageKind] : undefined;
    if (platform && !pageUrl) throw new ApiError(400, 'UNSUPPORTED_PAGE', `${platform}/${pageKind} has no page mapping`);
    if (input.jobId && (!platform || pageKind !== 'search')) throw new ApiError(400, 'INVALID_PARAMETER', 'jobId requires a platform search page');
    const page = await this.obtainPage();
    const existing = this.options.cdpUrl ? [...this.sessions.values()].find((item) => item.page === page) : undefined;
    if (existing?.paused && platform) throw new ApiError(409, 'SESSION_PAUSED', 'Resume the session before navigating');
    const session: Session = existing ?? { sessionRef: randomUUID(), platform, paused: false, page, waiters: new Set(), lastActionAt: 0 };
    if (!existing) this.sessions.set(session.sessionRef, session);
    if (platform) {
      const url = new URL(pageUrl!);
      if (input.jobId) url.searchParams.set('jobId', input.jobId);
      try {
        await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const actualUrl = page.url();
        const expectedHost = url.hostname.replace(/^www\./, '');
        const actualHost = new URL(actualUrl).hostname;
        if (actualHost !== expectedHost && !actualHost.endsWith(`.${expectedHost}`))
          throw new Error(`Expected ${expectedHost}, but browser loaded ${actualUrl}`);
        console.info(`[browser.open] ${platform}/${pageKind} loaded ${actualUrl}`);
      } catch (error) {
        if (!existing) this.sessions.delete(session.sessionRef);
        const actualUrl = page.isClosed() ? '<closed>' : page.url();
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[browser.open] navigation failed: requested=${url.href} actual=${actualUrl} reason=${reason}`);
        throw new ApiError(502, 'NAVIGATION_FAILED', `${reason}; actual URL: ${actualUrl}`);
      }
      session.platform = platform;
      session.lastActionAt = Date.now();
    }
    return this.describe(session);
  }

  list() { return [...this.sessions.values()].map((session) => this.describe(session)); }
  get(ref: string): Session {
    const session = this.sessions.get(ref);
    if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', `session ${ref} not found`);
    return session;
  }
  pause(ref: string) {
    const session = this.get(ref);
    session.paused = true;
    /* DESIGN-DECISION: 无原始证据，自研 */
    // Playwright does not retain a mouse lock between steps. Blur the automated
    // element so the user can take keyboard focus without a pending locator action.
    void session.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()).catch(() => {});
  }
  resume(ref: string) {
    const session = this.get(ref);
    session.paused = false;
    for (const wake of session.waiters) wake();
    session.waiters.clear();
  }

  async checkpoint(ref: string, signal: AbortSignal): Promise<Session> {
    const session = this.get(ref);
    if (signal.aborted) throw new ApiError(409, 'OPERATION_CANCELLED', 'operation cancelled');
    while (session.paused) {
      if (this.sessions.get(ref) !== session) throw new ApiError(404, 'SESSION_NOT_FOUND', `session ${ref} was replaced`);
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal.removeEventListener('abort', abort); session.waiters.delete(wake); resolve(); };
        const abort = () => { session.waiters.delete(wake); reject(new ApiError(409, 'OPERATION_CANCELLED', 'operation cancelled')); };
        session.waiters.add(wake);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    const wait = (this.options.minIntervalMs ?? 1500) - (Date.now() - session.lastActionAt);
    if (wait > 0) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, wait);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new ApiError(409, 'OPERATION_CANCELLED', 'operation cancelled')); }, { once: true });
    });
    if (this.sessions.get(ref) !== session) throw new ApiError(404, 'SESSION_NOT_FOUND', `session ${ref} was replaced`);
    if (session.paused) return this.checkpoint(ref, signal);
    if (signal.aborted) throw new ApiError(409, 'OPERATION_CANCELLED', 'operation cancelled');
    session.lastActionAt = Date.now();
    return session;
  }

  async state(ref: string, signal: AbortSignal) {
    const session = await this.checkpoint(ref, signal);
    const page = session.page;
    return { ...this.describe(session), title: await page.title(), bodyText: (await page.locator('body').innerText().catch(() => '')).slice(0, 2000) };
  }

  async dismissAd(ref: string, signal: AbortSignal) {
    const session = await this.checkpoint(ref, signal);
    /* DESIGN-DECISION: 无原始证据，自研 */
    const close = session.page.locator('[role="dialog"] button[aria-label*="关闭"], [role="dialog"] button[aria-label*="Close"], .modal button.close, .popup button.close').first();
    if (await close.isVisible().catch(() => false)) {
      await this.checkpoint(ref, signal);
      await close.click({ timeout: 3000 });
      return { dismissed: true, method: 'click' };
    }
    await this.checkpoint(ref, signal);
    await session.page.keyboard.press('Escape');
    return { dismissed: false, method: 'escape' };
  }

  async close() { await this.browser?.close(); }
  private describe(session: Session) { return { sessionRef: session.sessionRef, platform: session.platform, paused: session.paused, url: session.page.url() }; }
  private async obtainPage() {
    if (!this.browser) {
      const executablePath = this.options.executablePath ?? process.env.CHROMIUM_EXECUTABLE;
      const useChrome = !executablePath && !existsSync(chromium.executablePath());
      this.browser = this.options.cdpUrl ? await chromium.connectOverCDP(this.options.cdpUrl) : await chromium.launch({ headless: this.options.headless ?? true, executablePath, channel: useChrome ? 'chrome' : undefined });
      this.context = this.options.cdpUrl ? this.browser.contexts()[0] : await this.browser.newContext();
      if (!this.context) throw new ApiError(503, 'CDP_CONTEXT_UNAVAILABLE', 'Electron CDP browser context is not ready');
    }
    if (!this.options.cdpUrl) return this.context!.newPage();
    if (this.embeddedPage && !this.embeddedPage.isClosed()) return this.embeddedPage;
    /* DESIGN-DECISION: 无原始证据，自研 */
    // The BrowserView's CDP target ID is supplied by Electron. It survives page.goto;
    // URLs are deliberately never used as a page identity.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (this.embeddedTargetId) {
        for (const page of this.context!.pages()) {
          if (page.isClosed()) continue;
          const cdp = await this.context!.newCDPSession(page).catch(() => undefined);
          if (!cdp) continue;
          try {
            const info = await cdp.send('Target.getTargetInfo');
            if (info.targetInfo.targetId === this.embeddedTargetId) {
              this.embeddedPage = page;
              return page;
            }
          } catch { /* Page may close while CDP targets are being enumerated. */ }
          finally { await cdp.detach().catch(() => {}); }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new ApiError(503, 'EMBEDDED_VIEW_NOT_READY', `BrowserView CDP target ${this.embeddedTargetId ?? '<unregistered>'} is not available`);
  }
}
