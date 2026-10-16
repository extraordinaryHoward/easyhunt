type Project = { id: string; title: string; description: string; recruitment_config: Record<string, unknown>; created_at: string };
type ResumeIndex = { id: string; project_id: string; local_ref: string; content_hash: string; display_name: string; stars: number; status: string; platform?: string; platform_candidate_ref?: string; created_at: string };
type Conversation = { id: string; project_id: string; title: string; created_at: string };
type Message = { id: string; conversation_id: string; role: string; content: string; created_at: string };
type Workspace = { projects: Project[]; resumes: ResumeIndex[]; conversations: Conversation[]; messages: Message[]; jobs: Array<Record<string, unknown>>; profileVersions: Array<Record<string, unknown>>; taskRuns: Array<Record<string, any>>; decisionHistory: Array<Record<string, any>> };
const key = 'easyhunt-local-workspace-v1';
const empty = (): Workspace => ({ projects: [], resumes: [], conversations: [], messages: [], jobs: [], profileVersions: [], taskRuns: [], decisionHistory: [] });
const now = () => new Date().toISOString();
async function read(): Promise<Workspace> {
  const value = window.easyhunt?.localStateRead ? await window.easyhunt.localStateRead() : JSON.parse(localStorage.getItem(key) ?? '{}');
  return { ...empty(), ...value };
}
async function write(value: Workspace) {
  if (window.easyhunt?.localStateWrite) await window.easyhunt.localStateWrite(value);
  else localStorage.setItem(key, JSON.stringify(value));
}
const fail = (message: string): never => { throw new Error(message); };
function portraitFromJd(jd: string) {
  /* DESIGN-DECISION: 无原始证据，自研 */
  // Offline mode quotes exact JD spans and leaves interpretation to the user.
  const terms = [jd.match(/博士|硕士|本科|大专/)?.[0], jd.match(/[一二三四五六七八九十\d]+年(?:以上)?(?:工作)?经验/)?.[0], ...Array.from(jd.matchAll(/TypeScript|JavaScript|React|Java|Python|Redis|Go语言/gi), x => x[0])].filter((x): x is string => Boolean(x));
  return { hardConditions: [...new Set(terms)].map(content => ({ content, evidence: [content] })), businessConditions: [], bonusItems: [] };
}
export async function localCloud(path: string, method: string, body?: any): Promise<any> {
  const url = new URL(path, 'http://local.easyhunt');
  const pathname = url.pathname;
  const db = await read();
  if (pathname === '/projects' && method === 'GET') return { items: db.projects.slice().reverse() };
  if (pathname === '/project' && method === 'POST') {
    if (!body?.title?.trim()) fail('请输入职位名称');
    const item: Project = { id: crypto.randomUUID(), title: body.title, description: body.description ?? '', recruitment_config: body.recruitmentConfig ?? {}, created_at: now() };
    db.projects.push(item); await write(db); return item;
  }
  const projectPath = pathname.match(/^\/project\/([0-9a-f-]+)$/);
  if (projectPath && method === 'GET') return db.projects.find(item => item.id === projectPath[1]) ?? fail('本地职位不存在');
  if (projectPath && method === 'PUT') {
    const item = db.projects.find(item => item.id === projectPath[1]) ?? fail('本地职位不存在');
    if (body?.title !== undefined) item.title = String(body.title).trim() || fail('请输入职位名称');
    if (body?.description !== undefined) item.description = String(body.description);
    if (body?.recruitmentConfig !== undefined) item.recruitment_config = body.recruitmentConfig;
    await write(db); return item;
  }
  if (pathname === '/llm/profile' && method === 'POST') {
    if (!body?.jd?.trim()) fail('请粘贴职位描述');
    return { profile: portraitFromJd(body.jd), promptVersion: 'local-rules-v1' };
  }
  if (pathname === '/resumes' && method === 'GET') return { items: db.resumes.filter(item => !url.searchParams.get('projectId') || item.project_id === url.searchParams.get('projectId')).reverse() };
  if (pathname === '/resumes' && method === 'POST') {
    if (!db.projects.some(item => item.id === body?.projectId)) fail('本地职位不存在');
    const existing = db.resumes.find(item => item.content_hash === body.contentHash);
    if (existing) return existing;
    const item: ResumeIndex = { id: crypto.randomUUID(), project_id: body.projectId, local_ref: body.localRef, content_hash: body.contentHash, display_name: body.displayName ?? '候选人', stars: body.stars ?? 1, status: 'NEW', platform: body.platform, platform_candidate_ref: body.platformCandidateRef, created_at: now() };
    db.resumes.push(item); await write(db); return item;
  }
  if (pathname === '/resumes/decision' && method === 'POST') {
    const ids = new Set(body?.resumeIds ?? []);
    if (!ids.size || !['PROMOTED', 'CONSIDERING', 'REJECTED'].includes(body?.decisionStatus)) fail('请选择简历及决策');
    for (const item of db.resumes) if (ids.has(item.id)) { item.status = body.decisionStatus; db.decisionHistory.push({ id: crypto.randomUUID(), resume_id: item.id, decision_status: body.decisionStatus, decision_reason: body.decisionReason ?? null, created_at: now() }); }
    await write(db); return { updatedCount: ids.size, decisionStatus: body.decisionStatus };
  }
  const historyPath = pathname.match(/^\/resume\/([0-9a-f-]+)\/decision-history$/);
  if (historyPath && method === 'GET') return { items: db.decisionHistory.filter(item => item.resume_id === historyPath[1]).reverse() };
  const taskRunsPath = pathname.match(/^\/project\/([0-9a-f-]+)\/task-runs$/);
  if (taskRunsPath && method === 'GET') return { items: db.taskRuns.filter(item => item.project_id === taskRunsPath[1]).reverse().slice(0, 20) };
  if (taskRunsPath && method === 'POST') {
    if (!db.projects.some(item => item.id === taskRunsPath[1])) fail('本地职位不存在');
    const existing = db.taskRuns.find(item => item.operation_id === body?.operationId);
    const next = { project_id: taskRunsPath[1], operation_id: body.operationId, platform: body.platform, status: body.status, events: body.events ?? [], metrics: body.metrics ?? {}, error: body.error ?? null, updated_at: now() };
    if (existing) { if (next.events.length >= (existing.events?.length ?? 0)) Object.assign(existing, next); }
    else db.taskRuns.push({ id: crypto.randomUUID(), created_at: now(), ...next });
    await write(db); return existing ?? db.taskRuns.at(-1);
  }
  if (pathname === '/chat/conversations' && method === 'GET') return { items: db.conversations };
  if (pathname === '/chat/conversations' && method === 'POST') {
    const item: Conversation = { id: crypto.randomUUID(), project_id: body.projectId, title: body.title, created_at: now() };
    db.conversations.push(item); await write(db); return item;
  }
  const messages = pathname.match(/^\/chat\/conversations\/([0-9a-f-]+)\/messages$/);
  if (messages && method === 'GET') return { items: db.messages.filter(item => item.conversation_id === messages[1]) };
  if (messages && method === 'POST') {
    const item: Message = { id: crypto.randomUUID(), conversation_id: messages[1], role: body.role, content: body.content, created_at: now() };
    db.messages.push(item); await write(db); return { message: item, workflowEvents: [] };
  }
  if (/^\/project\/[0-9a-f-]+\/talent-profiles$/.test(pathname) && method === 'POST') {
    const item = { id: crypto.randomUUID(), project_id: pathname.split('/')[2], profile: body.profile, created_at: now() };
    const project = db.projects.find(project => project.id === item.project_id);
    if (!project) throw new Error('本地职位不存在');
    project.recruitment_config.portrait = body.profile;
    db.profileVersions.push(item); await write(db); return item;
  }
  if (/^\/project\/[0-9a-f-]+\/search-configs$/.test(pathname)) {
    const item = db.projects.find(project => project.id === pathname.split('/')[2]) ?? fail('本地职位不存在');
    if (method === 'GET') return { items: item.recruitment_config.searchConfig ? [{ config: item.recruitment_config.searchConfig }] : [] };
    if (method === 'PUT') { item.recruitment_config.searchConfig = body?.config ?? {}; await write(db); return { config: item.recruitment_config.searchConfig }; }
  }
  if (/^\/project\/[0-9a-f-]+\/settings-versions$/.test(pathname)) {
    const item = db.projects.find(project => project.id === pathname.split('/')[2]) ?? fail('本地职位不存在');
    if (method === 'GET') return { items: item.recruitment_config.taskSettings ? [{ settings: item.recruitment_config.taskSettings, version: 1, is_current: true }] : [] };
    if (method === 'PUT') { item.recruitment_config.taskSettings = body?.settings ?? {}; await write(db); return { settings: item.recruitment_config.taskSettings, version: 1, is_current: true }; }
  }
  if (pathname === '/user/platform-jobs' && method === 'GET') return { items: db.jobs };
  if (pathname === '/user/platform-jobs/sync' && method === 'POST') {
    for (const job of body?.jobs ?? []) {
      const existing = db.jobs.find(item => item.platform === job.platform && item.platformJobRef === job.platformJobRef);
      if (existing) Object.assign(existing, job, { updated_at: now() });
      else db.jobs.push({ id: crypto.randomUUID(), ...job, updated_at: now() });
    }
    await write(db); return { syncId: crypto.randomUUID(), status: 'completed' };
  }
  if (pathname === '/billing/credits' && method === 'GET') return { localMode: true, balance: null };
  if (pathname.startsWith('/resume/') && pathname.includes('/shares') || pathname === '/resumes/shared' || pathname === '/resume/share-users/lookup') fail('本地模式无法跨账户分享；连接云服务后才能使用协作分享');
  fail(`本地模式暂不支持 ${method} ${pathname}`);
}
