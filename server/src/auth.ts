import { createHash, randomInt, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { SignJWT, jwtVerify } from 'jose';
import type { Db } from './db.js';
import { ApiError } from './errors.js';

export interface CodeStore { get(key: string): Promise<string | null>; set(key: string, value: string, ttlSeconds: number): Promise<void>; del(key: string): Promise<void>; increment(key: string, ttlSeconds: number): Promise<number>; close(): Promise<void> }
export class MemoryCodeStore implements CodeStore {
  private entries = new Map<string, { value: string; expires: number }>();
  async get(key: string) { const item = this.entries.get(key); return item && item.expires > Date.now() ? item.value : null; }
  async set(key: string, value: string, ttlSeconds: number) { this.entries.set(key, { value, expires: Date.now() + ttlSeconds * 1000 }); }
  async del(key: string) { this.entries.delete(key); }
  async increment(key: string, ttlSeconds: number) { const value = Number(await this.get(key) ?? 0) + 1; await this.set(key, String(value), ttlSeconds); return value; }
  async close() {}
}
export function redisCodeStore(url = process.env.REDIS_URL): CodeStore {
  if (!url) throw new Error('REDIS_URL is required');
  const client = new Redis(url, { maxRetriesPerRequest: 1 });
  return { get: key => client.get(key), set: async (key, value, ttl) => { await client.set(key, value, 'EX', ttl); }, del: async key => { await client.del(key); }, increment: async (key, ttl) => { const value = await client.incr(key); if (value === 1) await client.expire(key, ttl); return value; }, close: async () => { client.disconnect(); } };
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const phonePattern = /^1[3-9]\d{9}$/;
export type SmsSender = (phone: string, code: string) => Promise<void>;

export class AuthService {
  private key: Uint8Array;
  constructor(private db: Db, private codes: CodeStore, secret: string, private sendSms: SmsSender) {
    if (secret.length < 32) throw new Error('JWT_SECRET must have at least 32 characters');
    this.key = new TextEncoder().encode(secret);
  }
  async sendCode(phone: string) {
    if (!phonePattern.test(phone)) throw new ApiError(400, 'INVALID_PHONE', 'Invalid mobile phone number');
    if (await this.codes.get(`cooldown:${phone}`)) throw new ApiError(429, 'CODE_RATE_LIMITED', 'Wait before requesting another code');
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    await this.codes.set(`otp:${phone}`, hash(code), 300);
    await this.codes.set(`cooldown:${phone}`, '1', 60);
    await this.sendSms(phone, code);
    return { sent: true, expiresIn: 300 };
  }
  async login(phone: string, code: string) {
    if (!phonePattern.test(phone) || !/^\d{6}$/.test(code)) throw new ApiError(400, 'INVALID_CREDENTIALS', 'Invalid phone or code');
    const attempts = await this.codes.increment(`attempts:${phone}`, 300);
    if (attempts > 5) throw new ApiError(429, 'CODE_ATTEMPTS_EXCEEDED', 'Too many attempts');
    if (await this.codes.get(`otp:${phone}`) !== hash(code)) throw new ApiError(401, 'INVALID_CODE', 'Code is invalid or expired');
    await this.codes.del(`otp:${phone}`);
    await this.codes.del(`attempts:${phone}`);
    const rows = await this.db.query<{ id: string; phone: string }>('INSERT INTO accounts(phone) VALUES($1) ON CONFLICT(phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING id,phone', [phone]);
    const account = rows[0];
    await this.db.query('INSERT INTO credit_accounts(account_id,balance) VALUES($1,0) ON CONFLICT(account_id) DO NOTHING', [account.id]);
    return { account, ...await this.issue(account.id) };
  }
  private async issue(accountId: string) {
    const accessToken = await new SignJWT({ typ: 'access' }).setProtectedHeader({ alg: 'HS256' }).setSubject(accountId).setIssuer('easyhunt').setIssuedAt().setExpirationTime('15m').sign(this.key);
    const refreshToken = await new SignJWT({ typ: 'refresh', nonce: randomUUID() }).setProtectedHeader({ alg: 'HS256' }).setSubject(accountId).setIssuer('easyhunt').setIssuedAt().setExpirationTime('30d').sign(this.key);
    await this.db.query("INSERT INTO refresh_tokens(account_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')", [accountId, hash(refreshToken)]);
    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: 900 };
  }
  async verifyAccess(token: string) {
    try { const { payload } = await jwtVerify(token, this.key, { issuer: 'easyhunt' }); if (payload.typ !== 'access' || !payload.sub) throw new Error('wrong token type'); return payload.sub; }
    catch { throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired access token'); }
  }
  async refresh(token: string) {
    let accountId: string;
    try { const { payload } = await jwtVerify(token, this.key, { issuer: 'easyhunt' }); if (payload.typ !== 'refresh' || !payload.sub) throw new Error('wrong token type'); accountId = payload.sub; }
    catch { throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Invalid refresh token'); }
    const consumed = await this.db.query<{ account_id: string }>('UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND account_id=$2 AND revoked_at IS NULL AND expires_at>now() RETURNING account_id', [hash(token), accountId]);
    if (!consumed.length) throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token already used or expired');
    return this.issue(accountId);
  }
}
