import pg from 'pg';
import { expect } from 'vitest';
import { TEST_URL } from './url';

const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });

export const closePool = () => pool.end();

/** Runs fn in a transaction that is always rolled back, acting as the user with this email (null = nobody). */
export async function tx(email: string | null, fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (email) await actAs(c, email);
    await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

export async function actAs(c: pg.PoolClient, email: string): Promise<number> {
  const { rows } = await c.query<{ id: string }>(
    "SELECT set_config('app.current_user_id', (SELECT id::text FROM users WHERE email = $1), true) AS id",
    [email],
  );
  return Number(rows[0]!.id);
}

/** Expects the statement to fail with this SQLSTATE; the transaction stays usable (savepoint). */
export async function expectSqlState(c: pg.PoolClient, sql: string, params: unknown[], code: string) {
  await c.query('SAVEPOINT expect_error');
  try {
    await c.query(sql, params);
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT expect_error');
    expect((e as { code?: string }).code, (e as Error).message).toBe(code);
    return e as Error;
  }
  throw new Error(`Expected SQLSTATE ${code}, statement succeeded: ${sql}`);
}

export async function one<T = Record<string, unknown>>(c: pg.PoolClient, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await c.query(sql, params);
  if (rows.length !== 1) throw new Error(`Expected 1 row, got ${rows.length}: ${sql}`);
  return rows[0] as T;
}

/** CALL sp_x(..., NULL) → the INOUT id */
export async function call(c: pg.PoolClient, proc: string, args: unknown[]): Promise<number> {
  const placeholders = [...args.map((_, i) => `$${i + 1}`), 'NULL'].join(', ');
  const row = await one<Record<string, number>>(c, `CALL ${proc}(${placeholders})`, args);
  return Number(Object.values(row)[0]);
}
