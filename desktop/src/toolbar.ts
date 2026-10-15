type Reply = { status: number; body: Record<string, any> };
declare global { interface Window { easyhunt: { request(path: string, method: string, body?: unknown): Promise<Reply> } } }
const el = (id: string) => document.getElementById(id)!;
let sessionRef = '';
let operationId = '';
const show = (value: unknown) => { el('result').textContent = JSON.stringify(value); };
async function call(path: string, method = 'GET', body?: unknown) {
  const reply = await window.easyhunt.request(path, method, body);
  if (reply.status >= 400) throw new Error(reply.body.error?.message ?? `HTTP ${reply.status}`);
  return reply.body;
}
async function act(id: string, run: () => Promise<unknown>) {
  el('status').textContent = `${id}中`;
  try { show(await run()); await refresh(); } catch (error) { el('status').textContent = '错误'; show(error instanceof Error ? error.message : String(error)); }
}
async function refresh() {
  if (!sessionRef) return;
  const sessions = await call('/sessions');
  const session = sessions.sessions.find((entry: { sessionRef: string }) => entry.sessionRef === sessionRef);
  el('status').textContent = session?.paused ? '已暂停 · 人工接管' : '运行中';
}
async function poll(id: string) {
  for (let i = 0; i < 100; i++) {
    const operation = await call(`/operations/${id}`);
    if (['succeeded', 'failed', 'cancelled'].includes(operation.status)) return operation;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { operationId: id, status: 'running' };
}
el('sign').onclick = () => act('授权', async () => call('/authorizations', 'POST', {
  platform: 'boss', phone: (el('phone') as HTMLInputElement).value,
  authorized: (el('authorize') as HTMLInputElement).checked,
  signedAgreement: (el('agreement') as HTMLInputElement).checked
}));
el('open').onclick = () => act('打开', async () => {
  const result = await call('/browser/open', 'POST', { platform: 'boss', page: 'search' });
  sessionRef = result.browser.sessionRef;
  return result;
});
el('read').onclick = () => act('读取', async () => {
  if (!sessionRef) throw new Error('先打开搜索页');
  const result = await call('/operations', 'POST', { action: 'candidates.list', sessionRef, contextRef: 'current-page' });
  operationId = result.operationId;
  return poll(operationId);
});
el('pause').onclick = () => act('暂停', async () => {
  if (!sessionRef) throw new Error('先打开搜索页');
  const result = await call(`/sessions/${sessionRef}/control`, 'POST', { action: 'session.pause' });
  return poll(result.operationId);
});
el('resume').onclick = () => act('继续', async () => {
  if (!sessionRef) throw new Error('先打开搜索页');
  const result = await call(`/sessions/${sessionRef}/control`, 'POST', { action: 'session.resume' });
  return poll(result.operationId);
});
el('revoke').onclick = () => act('撤销', async () => call('/authorizations/boss', 'DELETE'));
