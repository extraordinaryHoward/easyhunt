import { buildApp } from './app.js';
import { postgresDb } from './db.js';
import { redisCodeStore, type SmsSender } from './auth.js';

const db = postgresDb();
const codes = redisCodeStore();
const devSms = process.env.DEV_SMS_CODE === 'true';
const smsWebhook = process.env.SMS_WEBHOOK_URL;
if (!devSms && !smsWebhook) throw new Error('Configure SMS_WEBHOOK_URL or DEV_SMS_CODE=true for local development');
if (devSms && !['127.0.0.1', 'localhost', '::1'].includes(process.env.HOST ?? '127.0.0.1')) throw new Error('DEV_SMS_CODE is only allowed on localhost');
const sendSms: SmsSender = async (phone, code) => {
  if (devSms) { console.log(`DEV_SMS_CODE ${phone}: ${code}`); return; }
  const response = await fetch(smsWebhook!, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.SMS_WEBHOOK_TOKEN ?? ''}` }, body: JSON.stringify({ phone, code }) });
  if (!response.ok) throw new Error(`SMS webhook returned ${response.status}`);
};
const app = buildApp({ db, codes, jwtSecret: process.env.JWT_SECRET ?? '', sendSms });
const port = Number(process.env.PORT ?? 4320);
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
console.log(`Easyhunt cloud listening on http://127.0.0.1:${port}`);
const shutdown = async () => { await app.close(); await codes.close(); await db.close(); };
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
