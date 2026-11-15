// Shared helpers for R1–R4. The Redis library is imported by relative path (bench has no workspace dependency
// on @clinic/redis; same physical `redis` package via pnpm, so client types match).
import type { BenchContext } from '../../src/types';
import type { RedisCtx } from '@clinic/redis';

/** A RedisCtx for the library on the bench connection, under its own sub-prefix per scenario. */
export async function redisCtx(ctx: BenchContext, sub: string): Promise<RedisCtx> {
  return { client: await ctx.engines.redis(), prefix: `${ctx.engines.config.redisPrefix}:${sub}` };
}

export async function clearPrefix(r: RedisCtx): Promise<void> {
  for await (const batch of r.client.scanIterator({ MATCH: `${r.prefix}:*`, COUNT: 1000 })) {
    if (batch.length) await r.client.del(batch);
  }
}

/**
 * EXPLAIN (ANALYZE, BUFFERS) of a PG statement; writes are rolled back so the plan has no side effects.
 * EXPLAIN cannot wrap CALL, so for a procedure the plans of every statement inside it are captured with
 * auto_explain (log_nested_statements, delivered to the client as NOTICE).
 */
export async function explainPg(ctx: BenchContext, sql: string, params: unknown[]): Promise<string> {
  const c = await ctx.engines.pg.connect();
  const notices: string[] = [];
  const onNotice = (n: { message?: string }) => notices.push(n.message ?? '');
  try {
    await c.query('BEGIN');
    if (/^\s*CALL\b/i.test(sql)) {
      c.on('notice', onNotice);
      await c.query("LOAD 'auto_explain'");
      await c.query(`SET LOCAL auto_explain.log_min_duration = 0; SET LOCAL auto_explain.log_analyze = on;
        SET LOCAL auto_explain.log_buffers = on; SET LOCAL auto_explain.log_nested_statements = on;
        SET LOCAL auto_explain.log_level = notice`);
      await c.query(sql, params);
      return notices.join('\n\n');
    }
    const { rows } = await c.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    c.off('notice', onNotice);
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

// Every Redis scenario derives its inputs from the database deterministically (ORDER BY id, fixed formulas),
// so the shared params file is not needed: both engines get the same i-th input by construction.
export const INPUTS_NOTE = 'Вхідні дані виводяться детерміновано з бази (ORDER BY id) — обидва рушії отримують однаковий i-й запит.';
