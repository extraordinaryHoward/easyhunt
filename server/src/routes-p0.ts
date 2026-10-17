import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.js';
import type { AuthService } from './auth.js';
import { ApiError } from './errors.js';

type Context = { db: Db; auth: AuthService };
const uuid = z.uuid();
const platform = z.enum(['boss', 'liepin', 'liepin_enterprise', 'zhaopin']);
const parse = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> => { const result = schema.safeParse(value); if (!result.success) throw new ApiError(400, 'INVALID_REQUEST', result.error.message); return result.data; };
const projectBody = z.strictObject({ title: z.string().trim().min(1).max(200), description: z.string().max(5000).optional(), recruitmentConfig: z.record(z.string(), z.unknown()).default({}) });
const resumeBody = z.strictObject({ projectId: uuid, localRef: z.string().min(1).max(200), contentHash: z.string().regex(/^[a-f0-9]{64}$/), platform: platform.optional(), platformCandidateRef: z.string().max(200).optional(), displayName: z.string().max(100).optional(), expectedCity: z.string().max(100).optional(), expectedTitle: z.string().max(150).optional(), stars: z.number().int().min(1).max(5).optional() });
const jobBody = z.strictObject({ platform, platformJobRef: z.string().min(1).max(200), title: z.string().min(1).max(200), city: z.string().max(100).optional(), jobDescription: z.string().max(50000).optional(), status: z.string().max(50).optional() });

export function registerP0(app: FastifyInstance, { db, auth }: Context) {
  const account = async (request: { headers: { authorization?: string } }) => { const value = request.headers.authorization; if (!value?.startsWith('Bearer ')) throw new ApiError(401, 'UNAUTHORIZED', 'Bearer token required'); return auth.verifyAccess(value.slice(7)); };
  const ownedProject = async (accountId: string, id: string) => { const rows = await db.query('SELECT * FROM projects WHERE id=$1 AND account_id=$2', [parse(uuid, id), accountId]); if (!rows.length) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found'); return rows[0]; };
  const ownedResume = async (accountId: string, id: string) => { const rows = await db.query('SELECT * FROM resumes WHERE id=$1 AND account_id=$2', [parse(uuid, id), accountId]); if (!rows.length) throw new ApiError(404, 'RESUME_NOT_FOUND', 'Resume not found'); return rows[0]; };

  app.post('/auth/send-code', async request => { const { phone } = parse(z.strictObject({ phone: z.string() }), request.body); return auth.sendCode(phone); });
  app.post('/auth/login', async request => { const { phone, code } = parse(z.strictObject({ phone: z.string(), code: z.string() }), request.body); return auth.login(phone, code); });
  app.post('/auth/refresh', async request => { const { refreshToken } = parse(z.strictObject({ refreshToken: z.string() }), request.body); return auth.refresh(refreshToken); });
  app.get('/auth/me', async request => { const accountId = await account(request); const rows = await db.query('SELECT id,phone,created_at FROM accounts WHERE id=$1', [accountId]); return { account: rows[0] }; });

  app.post('/project', async (request, reply) => { const accountId = await account(request); const body = parse(projectBody, request.body); const rows = await db.query('INSERT INTO projects(account_id,title,description,recruitment_config) VALUES($1,$2,$3,$4::jsonb) RETURNING *', [accountId, body.title, body.description ?? null, JSON.stringify(body.recruitmentConfig)]); reply.code(201); return rows[0]; });
  app.get('/projects', async request => { const accountId = await account(request); return { items: await db.query('SELECT * FROM projects WHERE account_id=$1 ORDER BY created_at DESC', [accountId]) }; });
  app.get<{ Params: { id: string } }>('/project/:id', async request => ownedProject(await account(request), request.params.id));
  app.put<{ Params: { id: string } }>('/project/:id', async request => { const accountId = await account(request); await ownedProject(accountId, request.params.id); const body = parse(projectBody.partial(), request.body); const rows = await db.query('UPDATE projects SET title=COALESCE($3,title),description=COALESCE($4,description),recruitment_config=COALESCE($5::jsonb,recruitment_config),updated_at=now() WHERE id=$1 AND account_id=$2 RETURNING *', [request.params.id, accountId, body.title ?? null, body.description ?? null, body.recruitmentConfig ? JSON.stringify(body.recruitmentConfig) : null]); return rows[0]; });
  app.delete<{ Params: { id: string } }>('/project/:id', async (request, reply) => { const accountId = await account(request); await ownedProject(accountId, request.params.id); await db.transaction(async tx => {
    await tx.query('DELETE FROM share_recipients WHERE share_id IN (SELECT id FROM resume_shares WHERE resume_id IN (SELECT id FROM resumes WHERE project_id=$1 AND account_id=$2))', [request.params.id, accountId]);
    await tx.query('DELETE FROM resume_shares WHERE resume_id IN (SELECT id FROM resumes WHERE project_id=$1 AND account_id=$2)', [request.params.id, accountId]);
    await tx.query('DELETE FROM resume_decisions WHERE resume_id IN (SELECT id FROM resumes WHERE project_id=$1 AND account_id=$2)', [request.params.id, accountId]);
    await tx.query('DELETE FROM resumes WHERE project_id=$1 AND account_id=$2', [request.params.id, accountId]);
    await tx.query('DELETE FROM workflow_events WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id=$1 AND account_id=$2)', [request.params.id, accountId]);
    await tx.query('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id=$1 AND account_id=$2)', [request.params.id, accountId]);
    await tx.query('DELETE FROM conversations WHERE project_id=$1 AND account_id=$2', [request.params.id, accountId]);
    await tx.query('DELETE FROM agent_rounds WHERE run_id IN (SELECT id FROM agent_runs WHERE project_id=$1 AND account_id=$2)', [request.params.id, accountId]);
    await tx.query('DELETE FROM agent_runs WHERE project_id=$1 AND account_id=$2', [request.params.id, accountId]);
    await tx.query('DELETE FROM task_runs WHERE project_id=$1 AND account_id=$2', [request.params.id, accountId]);
    for (const table of ['search_configs', 'talent_profiles', 'settings_versions']) await tx.query(`DELETE FROM ${table} WHERE project_id=$1 AND account_id=$2`, [request.params.id, accountId]);
    await tx.query('DELETE FROM projects WHERE id=$1 AND account_id=$2', [request.params.id, accountId]);
  }); reply.code(204); });

  app.post('/resumes', async (request, reply) => { const accountId = await account(request); const body = parse(resumeBody, request.body); await ownedProject(accountId, body.projectId); const rows = await db.query('INSERT INTO resumes(account_id,project_id,local_ref,content_hash,platform,platform_candidate_ref,display_name,expected_city,expected_title,stars) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(account_id,project_id,content_hash) DO UPDATE SET local_ref=EXCLUDED.local_ref RETURNING *', [accountId, body.projectId, body.localRef, body.contentHash, body.platform ?? null, body.platformCandidateRef ?? null, body.displayName ?? null, body.expectedCity ?? null, body.expectedTitle ?? null, body.stars ?? null]); reply.code(201); return rows[0]; });
  app.get('/resumes', async request => { const accountId = await account(request); const query = parse(z.object({ projectId: uuid.optional() }), request.query); if (query.projectId) await ownedProject(accountId, query.projectId); return { items: await db.query(`SELECT * FROM resumes WHERE account_id=$1 ${query.projectId ? 'AND project_id=$2' : ''} ORDER BY created_at DESC`, query.projectId ? [accountId, query.projectId] : [accountId]) }; });
  app.get<{ Params: { id: string } }>('/resume/:id', async request => ownedResume(await account(request), request.params.id));

  /* DESIGN-DECISION: 无原始证据，自研 */
  // The cloud accepts job metadata supplied by an authorized local RPA client;
  // it never stores platform cookies or performs page automation.
  app.post('/user/platform-jobs/sync', async (request, reply) => { const accountId = await account(request); const body = parse(z.strictObject({ platform, syncId: uuid.optional(), jobs: z.array(jobBody).max(500).optional() }), request.body); if (body.jobs?.some(job => job.platform !== body.platform)) throw new ApiError(400, 'INVALID_REQUEST', 'Job platform mismatch'); if (body.syncId && !body.jobs) throw new ApiError(400, 'INVALID_REQUEST', 'jobs required to complete sync'); const output = await db.transaction(async tx => { let syncId: string; if (body.syncId) { const rows = await tx.query<{ id: string }>("UPDATE job_syncs SET status='completed',updated_at=now() WHERE id=$1 AND account_id=$2 AND platform=$3 AND status='pending' RETURNING id", [body.syncId, accountId, body.platform]); if (!rows.length) throw new ApiError(409, 'SYNC_NOT_PENDING', 'Sync not pending'); syncId = rows[0].id; } else syncId = (await tx.query<{ id: string }>('INSERT INTO job_syncs(account_id,platform,status) VALUES($1,$2,$3) RETURNING id', [accountId, body.platform, body.jobs ? 'completed' : 'pending']))[0].id; if (body.jobs) for (const job of body.jobs) await tx.query('INSERT INTO platform_jobs(account_id,platform,platform_job_ref,title,city,job_description,status) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id,platform,platform_job_ref) DO UPDATE SET title=EXCLUDED.title,city=COALESCE(EXCLUDED.city,platform_jobs.city),job_description=COALESCE(EXCLUDED.job_description,platform_jobs.job_description),status=EXCLUDED.status,updated_at=now()', [accountId, job.platform, job.platformJobRef, job.title, job.city ?? null, job.jobDescription ?? null, job.status ?? 'active']); return { syncId, status: body.jobs ? 'completed' : 'pending' }; }); reply.code(202); return output; });
  app.get('/user/platform-jobs', async request => { const accountId = await account(request); return { items: await db.query('SELECT * FROM platform_jobs WHERE account_id=$1 ORDER BY updated_at DESC', [accountId]) }; });
  app.get<{ Params: { id: string } }>('/user/platform-jobs/:id', async request => { const accountId = await account(request); const rows = await db.query('SELECT * FROM platform_jobs WHERE id=$1 AND account_id=$2', [parse(uuid, request.params.id), accountId]); if (!rows.length) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found'); return rows[0]; });
  app.post('/user/platform-jobs/sync-status', async request => { const accountId = await account(request); const { syncId } = parse(z.strictObject({ syncId: uuid }), request.body); const rows = await db.query('SELECT * FROM job_syncs WHERE id=$1 AND account_id=$2', [syncId, accountId]); if (!rows.length) throw new ApiError(404, 'SYNC_NOT_FOUND', 'Sync not found'); return rows[0]; });
  app.post('/user/platform-jobs/sync/pause', async request => { const accountId = await account(request); const { syncId } = parse(z.strictObject({ syncId: uuid }), request.body); const rows = await db.query("UPDATE job_syncs SET status='paused',updated_at=now() WHERE id=$1 AND account_id=$2 AND status='pending' RETURNING *", [syncId, accountId]); if (!rows.length) throw new ApiError(409, 'SYNC_NOT_PAUSABLE', 'Sync not pending'); return rows[0]; });

  app.get('/billing/credits', async request => { const accountId = await account(request); const rows = await db.query('SELECT balance FROM credit_accounts WHERE account_id=$1', [accountId]); return { balance: rows[0]?.balance ?? 0 }; });
  app.get('/billing/credits/ledger', async request => { const accountId = await account(request); return { items: await db.query('SELECT id,request_id,kind,amount,balance_after,created_at FROM credit_ledger WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100', [accountId]) }; });
  app.post('/billing/credits/deduct', async request => {
    const accountId = await account(request);
    const { requestId, kind } = parse(z.strictObject({ requestId: z.string().min(1).max(100), kind: z.enum(['quick_screen', 'initial_screen']) }), request.body);
    const amount = kind === 'quick_screen' ? 20 : 40;
    return db.transaction(async tx => {
      const existing = await tx.query<{ kind: string; amount: number; balance_after: number }>('SELECT kind,amount,balance_after FROM credit_ledger WHERE account_id=$1 AND request_id=$2', [accountId, requestId]);
      if (existing.length) { if (existing[0].kind !== kind) throw new ApiError(409, 'REQUEST_ID_CONFLICT', 'requestId used for a different charge'); return { requestId, kind, amount: -existing[0].amount, balance: existing[0].balance_after, idempotentReplay: true }; }
      const wallet = await tx.query<{ balance: number }>('SELECT balance FROM credit_accounts WHERE account_id=$1 FOR UPDATE', [accountId]);
      // A concurrent retry may have committed while this transaction waited for the wallet lock.
      const afterLock = await tx.query<{ kind: string; amount: number; balance_after: number }>('SELECT kind,amount,balance_after FROM credit_ledger WHERE account_id=$1 AND request_id=$2', [accountId, requestId]);
      if (afterLock.length) { if (afterLock[0].kind !== kind) throw new ApiError(409, 'REQUEST_ID_CONFLICT', 'requestId used for a different charge'); return { requestId, kind, amount: -afterLock[0].amount, balance: afterLock[0].balance_after, idempotentReplay: true }; }
      if (!wallet.length || wallet[0].balance < amount) throw new ApiError(409, 'INSUFFICIENT_CREDITS', 'Insufficient credits; stop the task');
      const balance = wallet[0].balance - amount;
      await tx.query('UPDATE credit_accounts SET balance=$2,updated_at=now() WHERE account_id=$1', [accountId, balance]);
      await tx.query('INSERT INTO credit_ledger(account_id,request_id,kind,amount,balance_after) VALUES($1,$2,$3,$4,$5)', [accountId, requestId, kind, -amount, balance]);
      return { requestId, kind, amount, balance, idempotentReplay: false };
    });
  });
  return { account, ownedProject, ownedResume, parse };
}
