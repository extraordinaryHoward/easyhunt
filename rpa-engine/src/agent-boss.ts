import { readFile } from 'node:fs/promises';

const base = `http://127.0.0.1:${process.env.PORT ?? 4317}`;
const args = process.argv.slice(2);
const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const projectId = value('--project');
const jobTitle = value('--job');
const profileFile = value('--profile');
if (!projectId || !jobTitle || !profileFile) { console.error('Usage: npm run agent:boss -- --project UUID --job "岗位名称" --profile profile.json'); process.exit(2); }
const profile = JSON.parse(await readFile(profileFile, 'utf8')) as Record<string, unknown>;
async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(data)}`);
  return data;
}
try {
  const sessions = await request('/sessions');
  const existing = sessions.sessions.find((session: { platform: string }) => session.platform === 'boss');
  const sessionRef: string = existing?.sessionRef ?? (await request('/browser/open', 'POST', { platform: 'boss', page: 'search' })).browser.sessionRef;
  const { operationId } = await request('/workflows/boss/agent', 'POST', { sessionRef, projectId, jobTitle, profile, recruitmentMode: 'target' });
  console.log(`operationId=${operationId} sessionRef=${sessionRef}`);
  let lastStatus = '';
  for (let attempt = 0; attempt < 2400; attempt++) {
    const operation = await request(`/operations/${operationId}`);
    if (operation.status !== lastStatus) { console.log(`${new Date().toISOString()} ${operation.status}`); lastStatus = operation.status; }
    if (['succeeded', 'failed', 'cancelled'].includes(operation.status)) { console.log(JSON.stringify(operation, null, 2)); process.exitCode = operation.status === 'succeeded' ? 0 : 1; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
} catch (error) { console.error(error); process.exitCode = 1; }
