import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { extname, isAbsolute } from 'node:path';
import { ApiError, byAction, commands, objectBody, validate } from './spec.js';
import { OperationQueue } from './operations.js';
import { BrowserManager, type Platform } from './browser.js';
import { SkillRegistry } from './skills/registry.js';
import type { SkillContext } from './skills/types.js';
import { RateLimiter, ratePolicyFromEnv } from './rate-limit.js';
import { collectCandidates } from './workflows/collect.js';
import { cloudAgentPlanner, runAgentRounds, type AgentPlanner } from './workflows/agent.js';
import { runResumePipeline } from './resume/pipeline.js';
import { JobSchema } from './resume/schema.js';

type Task = { taskId: string; input: Record<string, unknown>; updatedAt: string };
export function buildApp(options: { browser?: BrowserManager; skills?: SkillRegistry; rateLimiter?: RateLimiter; agentPlanner?: AgentPlanner; bridgeSecret?: string } = {}) {
  const app = Fastify({ logger: false });
  const queue = new OperationQueue();
  const tasks = new Map<string, Task>();
  const skills = options.skills ?? new SkillRegistry();
  const browser = options.browser ?? new BrowserManager({ cdpUrl: process.env.EASYHUNT_CDP_URL, headless: process.env.HEADLESS !== 'false', minIntervalMs: 0, skills });
  const limiter = options.rateLimiter ?? new RateLimiter(ratePolicyFromEnv());
  const authorizations = new Map<string, { phone: string; signedAt: string; agreementVersion: string }>();

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof Error && 'statusCode' in error && error.statusCode === 400) {
      reply.code(400).send({ error: { code: 'INVALID_BODY', message: error.message } });
      return;
    }
    reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  app.get('/status', async () => ({ status: 'ok', service: 'easyhunt-rpa-engine', commandCount: commands.length }));
  app.get('/bridge/view', async (_request, reply) => reply.type('text/html').send('<!doctype html><html><head><title>Easyhunt BrowserView</title></head><body></body></html>'));
  app.post('/bridge/target', async (request) => {
    const secret = process.env.EASYHUNT_BRIDGE_SECRET;
    if (!secret || request.headers['x-easyhunt-bridge-secret'] !== secret)
      throw new ApiError(403, 'BRIDGE_REGISTRATION_DENIED', 'BrowserView registration is restricted to the desktop process');
    const input = objectBody(request.body);
    return browser.registerEmbeddedTarget(input.targetId as string);
  });
  app.post('/resumes/import-local-pdfs', async request => {
    const secret = process.env.EASYHUNT_BRIDGE_SECRET;
    if (!secret || request.headers['x-easyhunt-bridge-secret'] !== secret)
      throw new ApiError(403, 'LOCAL_IMPORT_DENIED', 'PDF import is restricted to the desktop process');
    const input = objectBody(request.body);
    if (!Array.isArray(input.pdfPaths) || input.pdfPaths.length < 1 || input.pdfPaths.length > 10 ||
        input.pdfPaths.some(path => typeof path !== 'string' || !isAbsolute(path) || extname(path).toLowerCase() !== '.pdf'))
      throw new ApiError(400, 'INVALID_PDF_PATHS', 'Select 1-10 local PDF files');
    const parsedJob = JobSchema.safeParse(input.job);
    if (!parsedJob.success) throw new ApiError(400, 'INVALID_JOB', 'Valid job requirements are required for PDF analysis');
    /* DESIGN-DECISION: 无原始证据，自研 */
    // Only the desktop file picker can reach this route. PDF bytes and parsed
    // text remain on this machine unless remote processing was separately enabled.
    return runResumePipeline(input.pdfPaths.map(pdfPath => ({ pdfPath: pdfPath as string })), parsedJob.data, { localOnly: true });
  });
  app.get('/sessions', async () => ({ sessions: browser.list() }));
  app.get('/authorizations', async () => ({ items: [...authorizations.entries()].map(([platform,value]) => ({ platform, signedAt: value.signedAt, agreementVersion: value.agreementVersion })) }));
  app.post('/authorizations', async (request) => {
    const secret = options.bridgeSecret ?? process.env.EASYHUNT_BRIDGE_SECRET;
    if (!secret || request.headers['x-easyhunt-bridge-secret'] !== secret)
      throw new ApiError(403, 'AUTHORIZATION_BRIDGE_REQUIRED', 'Platform authorization must be signed in the desktop client');
    const input = objectBody(request.body);
    if (input.platform !== 'boss') throw new ApiError(400, 'UNSUPPORTED_PLATFORM', 'Only boss is enabled in stage 2');
    if (typeof input.phone !== 'string' || !/^1[3-9]\d{9}$/.test(input.phone)) throw new ApiError(400, 'INVALID_PHONE', 'A bound Chinese mobile number is required');
    if (input.signedAgreement !== true || input.authorized !== true) throw new ApiError(400, 'AUTHORIZATION_REQUIRED', 'Explicit authorization and signed platform agreement are required');
    const signedAt = new Date().toISOString();
    authorizations.set('boss', { phone: input.phone, signedAt, agreementVersion: 'stage2-v1' });
    return { platform: 'boss', signedAt, agreementVersion: 'stage2-v1' };
  });
  app.delete<{ Params: { platform: string } }>('/authorizations/:platform', async (request) => {
    authorizations.delete(request.params.platform);
    queue.cancelActive();
    for (const session of browser.list()) if (session.platform === request.params.platform) browser.pause(session.sessionRef);
    return { revoked: true, platform: request.params.platform };
  });
  app.post('/bridge/reset-browser-data', async request => {
    const secret = process.env.EASYHUNT_BRIDGE_SECRET;
    if (!secret || request.headers['x-easyhunt-bridge-secret'] !== secret) throw new ApiError(403, 'BRIDGE_RESET_DENIED', 'Only the desktop process may clear browser sessions');
    queue.cancelActive();
    authorizations.clear();
    return browser.invalidateSessions();
  });
  app.post('/browser/open', async (request) => {
    const input = validate(requiredAction('browser.open'), objectBody(request.body));
    if (input.platform) requireAuthorization(String(input.platform));
    if (input.platform) await limiter.take(new AbortController().signal);
    const session = await browser.open({ platform: input.platform as Platform | undefined, page: input.page as string | undefined, jobId: input.jobId as string | undefined });
    return { browser: session };
  });

  app.post<{ Params: { ref: string } }>('/sessions/:ref/control', async (request, reply) => {
    const input = objectBody(request.body);
    const action = input.action;
    if (action !== 'session.pause' && action !== 'session.resume') throw new ApiError(400, 'UNKNOWN_ACTION', 'action must be session.pause or session.resume');
    const session = browser.get(request.params.ref);
    validate(requiredAction(action), { ...input, sessionRef: request.params.ref });
    if (action === 'session.pause') browser.pause(session.sessionRef);
    else { if (session.platform) requireAuthorization(session.platform); browser.resume(session.sessionRef); }
    const operation = queue.create(action, () => ({ sessionRef: session.sessionRef, paused: browser.get(session.sessionRef).paused }));
    reply.code(202);
    return { operationId: operation.operationId };
  });

  app.post('/operations', async (request, reply) => {
    const input = objectBody(request.body);
    if (typeof input.action !== 'string') throw new ApiError(400, 'MISSING_PARAMETER', 'action is required');
    const command = requiredAction(input.action);
    if (command.path !== '/operations' || command.method !== 'POST') throw new ApiError(400, 'UNKNOWN_ACTION', `action ${input.action} is not an operation command`);
    const parameters = validate(command, input);
    const skillActions = ['search.fields', 'search.get', 'search.set', 'search.apply', 'candidates.list', 'candidates.next', 'resume.read', 'resume.open', 'resume.close', 'jobs.list', 'jobs.select'];
    const realActions = ['browser.state', 'browser.dismiss-ad', ...skillActions];
    const sensitiveActions = ['candidates.greet', 'candidates.favorite', 'candidates.share'];
    const reference = typeof parameters.candidateRef === 'string' ? parameters.candidateRef : typeof parameters.jobRef === 'string' ? parameters.jobRef : undefined;
    if (!parameters.sessionRef && reference && (skillActions.includes(command.action) || sensitiveActions.includes(command.action))) parameters.sessionRef = skills.get('boss').resolveSessionRef(reference);
    if (sensitiveActions.includes(command.action)) {
      if (typeof parameters.sessionRef !== 'string') throw new ApiError(404, 'REFERENCE_NOT_FOUND', 'Candidate reference is not in a browser session');
      const session = browser.get(parameters.sessionRef);
      if (session.platform) requireAuthorization(session.platform);
      throw new ApiError(501, 'ACTION_NOT_IMPLEMENTED', `${command.action} has no platform execution in stage 3`);
    }
    if (realActions.includes(command.action)) {
      if (typeof parameters.sessionRef !== 'string' || !parameters.sessionRef) throw new ApiError(400, 'MISSING_PARAMETER', 'sessionRef is required for browser execution');
      const session = browser.get(parameters.sessionRef);
      if (session.platform) requireAuthorization(session.platform);
    }
    /* DESIGN-DECISION: 无原始证据，自研 */
    const operation = queue.create(command.action, async (signal, report) => {
      const ref = parameters.sessionRef as string;
      if (command.action === 'browser.state') { await limiter.take(signal); return browser.state(ref, signal); }
      if (command.action === 'browser.dismiss-ad') { await limiter.take(signal); return browser.dismissAd(ref, signal); }
      if (skillActions.includes(command.action)) return executeSkill(command.action, parameters, ref, signal, report);
      return { mock: true, action: command.action, parameters };
    });
    reply.code(202);
    return { operationId: operation.operationId };
  });
  app.get('/operations', async () => ({ items: queue.list(100) }));
  app.get<{ Params: { id: string } }>('/operations/:id', async (request) => queue.get(request.params.id));
  app.post<{ Params: { id: string } }>('/operations/:id/cancel', async (request) => queue.cancel(request.params.id));

  app.post('/workflows/boss/collect', async (request, reply) => {
    const input = objectBody(request.body);
    const ref = input.sessionRef;
    if (typeof ref !== 'string') throw new ApiError(400, 'MISSING_PARAMETER', 'sessionRef is required');
    const session = browser.get(ref);
    if (session.platform !== 'boss') throw new ApiError(400, 'UNSUPPORTED_PLATFORM', 'BOSS session required');
    requireAuthorization('boss');
    const jobTitle = input.jobTitle;
    const keywords = Array.isArray(input.keywords) ? input.keywords : [input.keyword];
    const city = input.city;
    if (typeof jobTitle !== 'string' || !jobTitle.trim() || !keywords.length || keywords.length > 10 || keywords.some(word => typeof word !== 'string' || !word.trim() || word.length > 80)) throw new ApiError(400, 'MISSING_PARAMETER', 'jobTitle and 1-10 keywords are required');
    const targetCount = input.targetCount ?? 20;
    const maxPages = input.maxPages ?? 10;
    const jobRef = input.jobRef;
    if (typeof targetCount !== 'number' || typeof maxPages !== 'number') throw new ApiError(400, 'INVALID_PARAMETER', 'targetCount and maxPages must be numbers');
    if (jobRef !== undefined && typeof jobRef !== 'string') throw new ApiError(400, 'INVALID_PARAMETER', 'jobRef must be a string');
    if (city !== undefined && typeof city !== 'string') throw new ApiError(400, 'INVALID_PARAMETER', 'city must be a string');
    /* DESIGN-DECISION: 无原始证据，自研 */
    // Search words run in the saved order inside one cancellable operation.
    // Candidate references are deduplicated across words before indexing.
    const operation = queue.create('boss.collect', async (signal, report) => {
      const candidates = new Map<string, unknown>();
      let pagesRead = 0;
      for (let index = 0; index < keywords.length; index++) {
        const keyword = keywords[index] as string;
        report('search.keyword', `执行第 ${index + 1}/${keywords.length} 组搜索词`, { keywordIndex: index + 1, keywordCount: keywords.length });
        const result = await collectCandidates(skills.get('boss'), context(ref, signal, report), { jobTitle, jobRef, keyword, city, targetCount, maxPages });
        pagesRead += result.pagesRead;
        for (const candidate of result.candidates) if (!candidates.has(candidate.candidateRef)) candidates.set(candidate.candidateRef, candidate);
      }
      return { jobTitle, keywords, pagesRead, collectedCount: candidates.size, candidates: [...candidates.values()] };
    });
    reply.code(202);
    return { operationId: operation.operationId };
  });

  app.post('/workflows/boss/job-description', async (request, reply) => {
    const input = objectBody(request.body);
    if (typeof input.sessionRef !== 'string' || typeof input.jobRef !== 'string' || typeof input.title !== 'string' || !input.title.trim()) throw new ApiError(400, 'MISSING_PARAMETER', 'sessionRef, jobRef and title are required');
    if (browser.get(input.sessionRef).platform !== 'boss') throw new ApiError(400, 'UNSUPPORTED_PLATFORM', 'BOSS session required');
    requireAuthorization('boss');
    const { sessionRef, jobRef, title } = input as { sessionRef: string; jobRef: string; title: string };
    const operation = queue.create('boss.job-description', (signal, report) => skills.get('boss').jobs.description(context(sessionRef, signal, report), jobRef, title).then(jobDescription => ({ jobDescription })));
    reply.code(202);
    return { operationId: operation.operationId };
  });

  app.post('/workflows/boss/agent', async (request, reply) => {
    const input = objectBody(request.body);
    if (input.recruitmentMode !== 'target') throw new ApiError(400, 'INVALID_PARAMETER', 'recruitmentMode must be target');
    if (typeof input.sessionRef !== 'string' || browser.get(input.sessionRef).platform !== 'boss') throw new ApiError(400, 'UNSUPPORTED_PLATFORM', 'BOSS session required');
    requireAuthorization('boss');
    if (typeof input.projectId !== 'string' || typeof input.jobTitle !== 'string' || !input.jobTitle.trim() || !input.profile || typeof input.profile !== 'object' || Array.isArray(input.profile)) throw new ApiError(400, 'MISSING_PARAMETER', 'projectId, jobTitle, and profile are required');
    const targetPerTerm = input.targetPerTerm ?? 10;
    const maxPages = input.maxPages ?? 2;
    if (!Number.isInteger(targetPerTerm) || !Number.isInteger(maxPages)) throw new ApiError(400, 'INVALID_PARAMETER', 'targetPerTerm and maxPages must be integers');
    const cloudToken = typeof input.cloudAccessToken === 'string' ? input.cloudAccessToken : process.env.EASYHUNT_CLOUD_ACCESS_TOKEN;
    if (!options.agentPlanner && !cloudToken) throw new ApiError(503, 'CLOUD_AUTH_REQUIRED', 'Cloud access token is required for agent mode');
    const planner = options.agentPlanner ?? cloudAgentPlanner({ baseUrl: process.env.EASYHUNT_CLOUD_BASE_URL ?? 'http://127.0.0.1:4320', accessToken: cloudToken! });
    const sessionRef = input.sessionRef;
    const operation = queue.create('boss.agent', (signal, report) => runAgentRounds(skills.get('boss'), context(sessionRef, signal, report), planner, { projectId: input.projectId as string, profile: input.profile as Record<string, unknown>, jobTitle: input.jobTitle as string, targetPerTerm: targetPerTerm as number, maxPages: maxPages as number }));
    reply.code(202);
    return { operationId: operation.operationId };
  });

  app.post('/tasks', async (request, reply) => {
    const input = validate(requiredAction('task.create'), objectBody(request.body));
    const taskInput = input.inputFile as Record<string, unknown>;
    const task: Task = { taskId: randomUUID(), input: taskInput, updatedAt: new Date().toISOString() };
    tasks.set(task.taskId, task);
    reply.code(201);
    return { task, mock: true };
  });
  app.get('/tasks', async () => ({ tasks: [...tasks.values()], mock: true }));
  app.get<{ Params: { id: string } }>('/tasks/:id', async (request) => ({ task: getTask(request.params.id), mock: true }));
  app.post<{ Params: { id: string } }>('/tasks/:id', async (request) => {
    const task = getTask(request.params.id);
    const input = validate(requiredAction('task.update'), { ...objectBody(request.body), taskId: request.params.id });
    task.input = { ...task.input, ...(input.inputFile as Record<string, unknown>) };
    task.updatedAt = new Date().toISOString();
    return { task, mock: true };
  });

  function getTask(id: string): Task {
    const task = tasks.get(id);
    if (!task) throw new ApiError(404, 'TASK_NOT_FOUND', `task ${id} not found`);
    return task;
  }
  function requireAuthorization(platform: string) {
    if (!authorizations.has(platform)) throw new ApiError(403, 'AUTHORIZATION_REQUIRED', `Sign the ${platform} platform agreement and authorize automation first`);
  }
  function context(ref: string, signal: AbortSignal, report?: SkillContext['report']): SkillContext {
    return { page: browser.get(ref).page, sessionRef: ref, signal, report, checkpoint: async () => { await browser.checkpoint(ref, signal); }, step: async () => {
      await browser.checkpoint(ref, signal);
      await limiter.take(signal);
      await browser.checkpoint(ref, signal);
    } };
  }
  async function executeSkill(action: string, parameters: Record<string, unknown>, ref: string, signal: AbortSignal, report?: SkillContext['report']) {
    const platform = browser.get(ref).platform;
    if (!platform) throw new ApiError(400, 'UNSUPPORTED_PLATFORM', 'Platform session required');
    const skill = skills.get(platform);
    const ctx = context(ref, signal, report);
    switch (action) {
      case 'search.fields': return { fields: await skill.search.fields(ctx) };
      case 'search.get': return { field: parameters.field, value: await skill.search.get(ctx, String(parameters.field)) };
      case 'search.set': await skill.search.set(ctx, String(parameters.field), parameters.value); return { field: parameters.field, applied: false };
      case 'search.apply': await skill.search.apply(ctx, parameters.patch as Record<string, unknown>); return { applied: true };
      case 'candidates.list': { const candidates = await skill.candidates.list(ctx); return { sessionRef: ref, candidates, count: candidates.length }; }
      case 'candidates.next': return { hasNext: await skill.candidates.next(ctx) };
      case 'resume.open': await skill.resume.open(ctx, String(parameters.candidateRef)); return { opened: true };
      case 'resume.read': return { candidateRef: parameters.candidateRef, text: await skill.resume.read(ctx, String(parameters.candidateRef)) };
      case 'resume.close': await skill.resume.close(ctx); return { closed: true };
      case 'jobs.list': return { jobs: await skill.jobs.list(ctx) };
      case 'jobs.select': await skill.jobs.select(ctx, String(parameters.jobRef)); return { selected: true, jobRef: parameters.jobRef };
      default: throw new ApiError(501, 'ACTION_NOT_IMPLEMENTED', `${action} has no skill handler`);
    }
  }
  app.addHook('onClose', async () => { await browser.close(); });
  return app;
}

function requiredAction(action: string) {
  const command = byAction.get(action);
  if (!command) throw new ApiError(400, 'UNKNOWN_ACTION', `unknown action ${action}`);
  return command;
}
