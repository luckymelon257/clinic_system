import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const migrationsDir = `${pkgDir}migrations`;
const seedsDir = `${pkgDir}seeds`;
const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));

export const DEFAULT_DATABASE_URL = 'postgres://clinic:clinic@localhost:5434/clinic';

/** DATABASE_URL from the environment (repo-root .env is loaded if present), else the local docker default. */
export function databaseUrl(): string {
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv); // never overrides variables that are already set
  return process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
}

/** Same server / credentials as `url`, different database name. */
export function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const sqlFiles = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

/** CREATE DATABASE if it does not exist (connects to the `postgres` maintenance db). */
export async function ensureDatabase(url: string): Promise<void> {
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  await withClient(withDatabase(url, 'postgres'), async (c) => {
    const { rowCount } = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await c.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
  });
}

/** Applies pending migrations/*.sql in order, each in its own transaction, tracked in schema_migrations. */
export async function migrate(url: string): Promise<string[]> {
  await ensureDatabase(url);
  return withClient(url, async (c) => {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await c.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    const applied: string[] = [];
    for (const file of sqlFiles(migrationsDir)) {
      if (done.has(file)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(`${migrationsDir}/${file}`, 'utf8'));
        await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`, { cause: e });
      }
      applied.push(file);
    }
    return applied;
  });
}

/** Runs seeds/*.sql in order (each in a transaction). Files with `volume` in the name only when volume = true. */
export async function seed(url: string, opts: { volume: boolean }): Promise<string[]> {
  return withClient(url, async (c) => {
    const ran: string[] = [];
    for (const file of sqlFiles(seedsDir)) {
      if (file.includes('volume') && !opts.volume) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(`${seedsDir}/${file}`, 'utf8'));
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`Seed ${file} failed: ${(e as Error).message}`, { cause: e });
      }
      ran.push(file);
    }
    if (opts.volume) await c.query('VACUUM ANALYZE');
    else await c.query('ANALYZE');
    return ran;
  });
}

/** DROP SCHEMA public CASCADE → recreate → migrate → seed. */
export async function resetDatabase(url: string, opts: { volume: boolean }): Promise<void> {
  await ensureDatabase(url);
  await withClient(url, async (c) => {
    await c.query('DROP SCHEMA IF EXISTS public CASCADE');
    await c.query('CREATE SCHEMA public');
  });
  await migrate(url);
  await seed(url, opts);
}
