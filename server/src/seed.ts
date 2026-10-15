import { randomUUID } from 'node:crypto';
import { postgresDb } from './db.js';

if (process.env.NODE_ENV !== 'development') throw new Error('Seed only permitted with NODE_ENV=development');
const phone = process.env.SEED_PHONE;
const credits = Number(process.env.SEED_CREDITS ?? 200);
if (!phone || !/^1[3-9]\d{9}$/.test(phone) || !Number.isInteger(credits) || credits <= 0) throw new Error('Set valid SEED_PHONE and positive SEED_CREDITS');
const db = postgresDb();
try {
  const account = (await db.query<{ id: string }>('SELECT id FROM accounts WHERE phone=$1', [phone]))[0];
  if (!account) throw new Error('Log in once before seeding credits');
  const requestId = process.env.SEED_REQUEST_ID ?? `dev-seed-${randomUUID()}`;
  await db.transaction(async tx => {
    const existing = await tx.query('SELECT id FROM credit_ledger WHERE account_id=$1 AND request_id=$2', [account.id, requestId]);
    if (existing.length) return;
    const wallet = (await tx.query<{ balance: number }>('SELECT balance FROM credit_accounts WHERE account_id=$1 FOR UPDATE', [account.id]))[0];
    const balance = wallet.balance + credits;
    await tx.query('UPDATE credit_accounts SET balance=$2 WHERE account_id=$1', [account.id, balance]);
    await tx.query('INSERT INTO credit_ledger(account_id,request_id,kind,amount,balance_after) VALUES($1,$2,$3,$4,$5)', [account.id, requestId, 'dev_seed', credits, balance]);
  });
  console.log('Development credits seeded');
} finally { await db.close(); }
