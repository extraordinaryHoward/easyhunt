// Local curl acceptance harness. Production uses main.ts with PostgreSQL + Redis.
import { buildApp } from './app.js';
import { MemoryCodeStore } from './auth.js';
import { migrate, pgliteDb } from './db.js';
import { LlmClient } from './llm/client.js';
import { LlmService } from './llm/service.js';

const db = pgliteDb();
await migrate(db);
const phone = process.env.DEMO_PHONE ?? '13800009999';
if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error('Invalid DEMO_PHONE');
const account = (await db.query<{ id: string }>('INSERT INTO accounts(phone) VALUES($1) ON CONFLICT(phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING id', [phone]))[0];
await db.query('INSERT INTO credit_accounts(account_id,balance) VALUES($1,2000) ON CONFLICT(account_id) DO UPDATE SET balance=2000', [account.id]);
const codes = new MemoryCodeStore();
const demoLlm = process.env.DEMO_LLM === 'true' ? new LlmService(new LlmClient({ model:'demo', baseUrl:'https://invalid.example', apiKey:'demo', timeoutMs:1000, retries:0, perHourLimit:100 }, codes, async (_url, init) => { const request=JSON.parse(String(init.body)); const jd=String(request.messages?.[1]?.content??''); const excerpt=jd.includes('本科')?'本科':jd.slice(0,4); return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({hardConditions:[{content:excerpt,evidence:[excerpt]}],businessConditions:[],bonusItems:[]})}}]})); })) : undefined;
const app = buildApp({ db, codes, jwtSecret: 'local-embedded-demo-secret-32-chars', sendSms: async (to, code) => { console.log(`DEV_SMS_CODE ${to}: ${code}`); }, llmService:demoLlm, shareKey:'f'.repeat(64) });
const port = Number(process.env.PORT ?? 4321);
await app.listen({ host: '127.0.0.1', port });
console.log(`Embedded acceptance server at http://127.0.0.1:${port}; demo phone ${phone}, opening balance 2000`);
process.once('SIGINT', () => { void app.close().then(() => db.close()); });
