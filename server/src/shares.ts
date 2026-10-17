import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.js';
import { ApiError } from './errors.js';

type Guard = { account: (request: { headers: { authorization?: string } }) => Promise<string>; ownedResume: (accountId: string, id: string) => Promise<Record<string, unknown>>; parse: <T extends z.ZodType>(schema: T, value: unknown) => z.infer<T> };
const uuid = z.uuid();
const decisionSchema = z.strictObject({ decisionStatus: z.enum(['PROMOTED', 'CONSIDERING', 'REJECTED']), decisionReason: z.string().max(500).optional() });
const contentSchema = z.strictObject({ sourceText: z.string().min(1).max(10000), document: z.null().default(null) });
const recipientSchema = z.strictObject({ userId: uuid, permission: z.enum(['READ', 'EDIT']) });

/* DESIGN-DECISION: 无原始证据，自研 */
// A share is an explicit copy of selected text, encrypted at rest. Original
// PDF files and the full local resume record are never uploaded by this route.
function cipher(keyHex: string) {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new ApiError(503, 'SHARE_ENCRYPTION_NOT_CONFIGURED', 'Set a 32-byte SHARE_ENCRYPTION_KEY');
  return {
    encrypt(value: unknown) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([c.update(JSON.stringify(value)), c.final()]); return Buffer.concat([iv, c.getAuthTag(), encrypted]).toString('base64'); },
    decrypt(value: string) { const data = Buffer.from(value, 'base64'); const c = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); c.setAuthTag(data.subarray(12, 28)); return JSON.parse(Buffer.concat([c.update(data.subarray(28)), c.final()]).toString('utf8')); },
  };
}

export function registerCollaborationRoutes(app: FastifyInstance, db: Db, g: Guard, shareKey = process.env.SHARE_ENCRYPTION_KEY ?? '') {
  const getShare = async (accountId: string, resumeId: string, shareId: string) => {
    const rows = await db.query<{ id: string; resume_id: string; owner_id: string; audience: string; encrypted_content: string; created_at: string; expires_at: string }>('SELECT * FROM resume_shares WHERE id=$1 AND resume_id=$2', [g.parse(uuid, shareId), g.parse(uuid, resumeId)]);
    const share = rows[0];
    if (!share) throw new ApiError(404, 'SHARE_NOT_FOUND', 'Share not found');
    if (new Date(share.expires_at).getTime() <= Date.now()) throw new ApiError(410, 'SHARE_EXPIRED', 'Share has expired');
    if (share.owner_id === accountId) return { share, permission: 'OWNER' };
    if (share.audience === 'all') return { share, permission: 'READ' };
    const recipients = await db.query<{ permission: string }>('SELECT permission FROM share_recipients WHERE share_id=$1 AND account_id=$2', [shareId, accountId]);
    if (!recipients.length) throw new ApiError(404, 'SHARE_NOT_FOUND', 'Share not found');
    return { share, permission: recipients[0].permission };
  };

  app.post('/resumes/decision', async request => { const accountId = await g.account(request); const body = g.parse(z.strictObject({ resumeIds: z.array(uuid).min(1).max(100), ...decisionSchema.shape }), request.body); const ids = [...new Set(body.resumeIds)]; return db.transaction(async tx => { const owned = await tx.query<{ id: string }>('SELECT id FROM resumes WHERE account_id=$1 AND id=ANY($2::uuid[])', [accountId, ids]); if (owned.length !== ids.length) throw new ApiError(404, 'RESUME_NOT_FOUND', 'One or more resumes not found'); for (const id of ids) { await tx.query('INSERT INTO resume_decisions(resume_id,account_id,decision_status,decision_reason) VALUES($1,$2,$3,$4)', [id, accountId, body.decisionStatus, body.decisionReason ?? null]); await tx.query('UPDATE resumes SET status=$3 WHERE id=$1 AND account_id=$2', [id, accountId, body.decisionStatus]); } return { updatedCount: ids.length, decisionStatus: body.decisionStatus }; }); });
  app.get('/resume/share-users/lookup', async request => { await g.account(request); const { phone } = g.parse(z.strictObject({ phone: z.string().regex(/^1[3-9]\d{9}$/) }), request.query); const rows = await db.query<{ id: string }>('SELECT id FROM accounts WHERE phone=$1', [phone]); return rows[0] ? { userId: rows[0].id } : { userId: null }; });
  app.post<{ Params: { id: string } }>('/resume/:id/shares', async request => { const accountId = await g.account(request); await g.ownedResume(accountId, request.params.id); const body = g.parse(z.strictObject({ audience: z.enum(['recipients', 'all']), recipients: z.array(recipientSchema).max(50).default([]), content: contentSchema, confirmed: z.literal(true) }), request.body); if (body.audience === 'recipients' && !body.recipients.length) throw new ApiError(400, 'RECIPIENTS_REQUIRED', 'Select at least one recipient'); if (body.audience === 'all' && body.recipients.length) throw new ApiError(400, 'INVALID_REQUEST', 'All-audience shares cannot have recipient overrides'); const crypto = cipher(shareKey); return db.transaction(async tx => { const share = (await tx.query<{ id: string; created_at: string; expires_at: string }>("INSERT INTO resume_shares(resume_id,owner_id,audience,encrypted_content,expires_at) VALUES($1,$2,$3,$4,now() + interval '1 month') RETURNING id,created_at,expires_at", [request.params.id, accountId, body.audience, crypto.encrypt(body.content)]))[0]; for (const recipient of body.recipients) { const exists = await tx.query('SELECT id FROM accounts WHERE id=$1', [recipient.userId]); if (!exists.length) throw new ApiError(400, 'RECIPIENT_NOT_FOUND', 'Recipient not found'); await tx.query('INSERT INTO share_recipients(share_id,account_id,permission) VALUES($1,$2,$3)', [share.id, recipient.userId, recipient.permission]); } return { id: share.id, resumeId: request.params.id, audience: body.audience, recipients: body.recipients, content: body.content, createdAt: share.created_at, expiresAt: share.expires_at }; }); });
  app.get<{ Params: { id: string } }>('/resume/:id/shares', async request => { const accountId = await g.account(request); await g.ownedResume(accountId, request.params.id); return { items: await db.query('SELECT id,resume_id,audience,created_at,expires_at FROM resume_shares WHERE resume_id=$1 AND owner_id=$2 ORDER BY created_at DESC', [request.params.id, accountId]) }; });
  app.get('/resumes/shared', async request => { const accountId = await g.account(request); return { items: await db.query("SELECT DISTINCT s.id,s.resume_id,s.audience,s.created_at,s.expires_at,r.display_name,r.stars FROM resume_shares s JOIN resumes r ON r.id=s.resume_id LEFT JOIN share_recipients p ON p.share_id=s.id AND p.account_id=$1 WHERE s.owner_id<>$1 AND s.expires_at>now() AND (s.audience='all' OR p.account_id=$1) ORDER BY s.created_at DESC", [accountId]) }; });
  app.get<{ Params: { id: string; shareId: string } }>('/resume/:id/shares/:shareId', async request => { const accountId = await g.account(request); const { share, permission } = await getShare(accountId, request.params.id, request.params.shareId); return { id: share.id, resumeId: share.resume_id, audience: share.audience, permission, content: cipher(shareKey).decrypt(share.encrypted_content), createdAt: share.created_at, expiresAt: share.expires_at }; });
  app.put<{ Params: { id: string; shareId: string } }>('/resume/:id/shares/:shareId', async request => { const accountId = await g.account(request); const { permission } = await getShare(accountId, request.params.id, request.params.shareId); if (permission !== 'OWNER' && permission !== 'EDIT') throw new ApiError(403, 'SHARE_READ_ONLY', 'Share is read-only'); const { content } = g.parse(z.strictObject({ content: contentSchema }), request.body); await db.query('UPDATE resume_shares SET encrypted_content=$2 WHERE id=$1', [request.params.shareId, cipher(shareKey).encrypt(content)]); return { updated: true }; });
  app.delete<{ Params: { id: string; shareId: string } }>('/resume/:id/shares/:shareId', async request => { const accountId = await g.account(request); await g.ownedResume(accountId, request.params.id); await db.transaction(async tx => { await tx.query('DELETE FROM share_recipients WHERE share_id=$1', [request.params.shareId]); await tx.query('DELETE FROM resume_shares WHERE id=$1 AND resume_id=$2 AND owner_id=$3', [request.params.shareId, request.params.id, accountId]); }); return { deleted: true }; });
}
