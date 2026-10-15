import { migrate, postgresDb } from './db.js';
const db = postgresDb();
try { await migrate(db); console.log('migrations applied'); }
finally { await db.close(); }
