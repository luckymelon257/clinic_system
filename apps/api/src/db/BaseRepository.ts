import type { Db } from './pool';

type Row = Record<string, unknown>;

const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Top-level snake_case → camelCase. Nested jsonb is already camelCase; old_data/new_data values pass through raw. */
function mapRow<T>(row: Row): T {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[camel(k)] = v;
  return out as T;
}

/** Reads only from v_* / mv_* / fn_*, writes only via CALL sp_* (enforced by `pnpm check:sql-access`). */
export class BaseRepository {
  constructor(protected readonly db: Db) {}

  async one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const { rows } = await this.db.query(sql, params);
    return rows[0] ? mapRow<T>(rows[0]) : null;
  }

  async many<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const { rows } = await this.db.query(sql, params);
    return rows.map((r) => mapRow<T>(r));
  }

  /** CALL proc($1..$n) — procedures without an INOUT id. */
  async call(proc: string, args: unknown[]): Promise<void> {
    await this.db.query(`CALL ${proc}(${args.map((_, i) => `$${i + 1}`).join(', ')})`, args);
  }

  /** CALL proc($1..$n, NULL) → the INOUT id (p_id / p_invoice_id). */
  async callReturningId(proc: string, args: unknown[]): Promise<number> {
    const placeholders = [...args.map((_, i) => `$${i + 1}`), 'NULL'].join(', ');
    const { rows } = await this.db.query(`CALL ${proc}(${placeholders})`, args);
    return Number(Object.values(rows[0] as Row)[0]);
  }
}

/**
 * WHERE builder. `eq` = column = value (skipped when undefined/null); `raw` = [sql with `$?` placeholders, value].
 * `page(limit, offset)` gives the LIMIT/OFFSET clause (goes after ORDER BY) and the full param list.
 */
export function where(eq: Record<string, unknown>, raw: [string, unknown][] = []) {
  const params: unknown[] = [];
  const conds: string[] = [];
  for (const [col, v] of Object.entries(eq)) {
    if (v === undefined || v === null) continue;
    params.push(v);
    conds.push(`${col} = $${params.length}`);
  }
  for (const [expr, v] of raw) {
    if (v === undefined || v === null) continue;
    params.push(v);
    conds.push(expr.replaceAll('$?', `$${params.length}`));
  }
  const sql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return {
    sql,
    params,
    page: (limit: number, offset: number) => ({
      limit: `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      params: [...params, limit, offset],
    }),
  };
}

export type Page<T> = { items: T[]; total: number };
