import postgres from 'postgres';
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = { query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>; transaction<T>(run: (tx: Db) => Promise<T>): Promise<T>; close(): Promise<void> };

export function postgresDb(url = process.env.DATABASE_URL): Db {
  if (!url) throw new Error('DATABASE_URL is required');
  const client = postgres(url, { max: 10 });
  const adapt = (connection: typeof client): Db => ({
    query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => [...await connection.unsafe(sql, params as never[])] as unknown as T[],
    transaction: async <T>(run: (tx: Db) => Promise<T>) => connection.begin(async tx => run(adapt(tx as unknown as typeof client))) as Promise<T>,
    close: async () => { await client.end(); },
  });
  return adapt(client);
}

export function pgliteDb(instance = new PGlite()): Db {
  const adapt = (connection: PGlite): Db => ({
    query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await connection.query<T>(sql, params)).rows,
    transaction: async <T>(run: (tx: Db) => Promise<T>) => connection.transaction(async tx => run(adapt(tx as unknown as PGlite))),
    close: async () => { await instance.close(); },
  });
  return adapt(instance);
}

export async function migrate(db: Db) {
  const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of (await readdir(directory)).filter(x => /^\d+.*\.sql$/.test(x)).sort()) {
    if ((await db.query('SELECT name FROM schema_migrations WHERE name=$1', [name])).length) continue;
    const sql = await readFile(path.join(directory, name), 'utf8');
    await db.transaction(async tx => {
      for (const statement of sql.split('--> statement-breakpoint').map(x => x.trim()).filter(Boolean)) await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    });
  }
}
