import { existsSync } from 'node:fs';
import pg from 'pg';

// Repo-root .env (never overrides variables that are already set). Scripts run with cwd = apps/api.
for (const p of ['.env', '../../.env']) if (existsSync(p)) process.loadEnvFile(p);

// numeric → number, date → 'YYYY-MM-DD'; timestamptz stays a Date and JSON.stringify emits ISO.
pg.types.setTypeParser(1700, parseFloat);
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://clinic:clinic@localhost:5434/clinic',
});

export type Db = pg.Pool | pg.PoolClient;
