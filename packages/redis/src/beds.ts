import type pg from 'pg';
import { key, keys, type RedisCtx } from './client';

// F-43: free / occupied bed counters per ward. Hash beds:ward:{wardId} {free, occupied}, set beds:wards.
// Writers (admit / transfer / discharge) apply HINCRBY after their PG transaction commits; a periodic
// reconcile() overwrites the counters from v_beds (PG is the source of truth, BR-11), so a lost increment
// (crash between commit and HINCRBY, Redis restart) heals within one reconcile period.

export type Queryable = Pick<pg.Pool | pg.PoolClient | pg.Client, 'query'>;

export interface WardCounts {
  free: number;
  occupied: number;
}

export interface BedChange {
  fromWardId?: number | null; // the bed that was released (discharge, transfer source)
  toWardId?: number | null; // the bed that was taken (admit, transfer target)
}

/** Atomic (MULTI/EXEC) increment of both wards; transfer within one ward is a no-op. */
export async function applyBedChange(ctx: RedisCtx, change: BedChange): Promise<void> {
  const from = change.fromWardId ?? null;
  const to = change.toWardId ?? null;
  if (from === to) return;
  const m = ctx.client.multi();
  if (from !== null) {
    m.hIncrBy(key(ctx, keys.bedWard(from)), 'free', 1).hIncrBy(key(ctx, keys.bedWard(from)), 'occupied', -1);
    m.sAdd(key(ctx, keys.bedWards), String(from));
  }
  if (to !== null) {
    m.hIncrBy(key(ctx, keys.bedWard(to)), 'free', -1).hIncrBy(key(ctx, keys.bedWard(to)), 'occupied', 1);
    m.sAdd(key(ctx, keys.bedWards), String(to));
  }
  await m.exec();
}

/** All wards' counters: SMEMBERS + one pipelined HGETALL per ward (one round trip). */
export async function readCounts(ctx: RedisCtx): Promise<Map<number, WardCounts>> {
  const ids = (await ctx.client.sMembers(key(ctx, keys.bedWards))).map(Number).sort((a, b) => a - b);
  const p = ctx.client.multi();
  for (const id of ids) p.hGetAll(key(ctx, keys.bedWard(id)));
  const rows = ids.length ? ((await p.execAsPipeline()) as unknown as Record<string, string>[]) : [];
  return new Map(ids.map((id, i) => [id, { free: Number(rows[i]?.free ?? 0), occupied: Number(rows[i]?.occupied ?? 0) }]));
}

export async function reconciledAt(ctx: RedisCtx): Promise<string | null> {
  return ctx.client.get(key(ctx, keys.bedReconciledAt));
}

/** Truth from PG: maintenance beds are neither free nor occupied. */
export async function countsFromPg(db: Queryable): Promise<Map<number, WardCounts>> {
  const { rows } = await db.query<{ ward_id: number; free: number; occupied: number }>(`
    SELECT ward_id, (count(*) FILTER (WHERE status = 'available'))::int AS free,
           (count(*) FILTER (WHERE status = 'occupied'))::int AS occupied
    FROM v_beds GROUP BY ward_id ORDER BY ward_id`);
  return new Map(rows.map((r) => [r.ward_id, { free: r.free, occupied: r.occupied }]));
}

export interface ReconcileDiff {
  wardId: number;
  redis: WardCounts | null;
  postgres: WardCounts;
}

/**
 * Overwrites the counters with v_beds and returns what was wrong. One MULTI: readers never see a half-updated
 * set. A HINCRBY racing between the PG read and EXEC is overwritten — the next reconcile corrects it (D-50).
 */
export async function reconcile(ctx: RedisCtx, db: Queryable): Promise<ReconcileDiff[]> {
  const truth = await countsFromPg(db);
  const current = await readCounts(ctx);
  const diffs: ReconcileDiff[] = [];
  for (const [wardId, pgc] of truth) {
    const rc = current.get(wardId) ?? null;
    if (!rc || rc.free !== pgc.free || rc.occupied !== pgc.occupied) diffs.push({ wardId, redis: rc, postgres: pgc });
  }
  const m = ctx.client.multi();
  for (const wardId of current.keys()) if (!truth.has(wardId)) m.del(key(ctx, keys.bedWard(wardId))).sRem(key(ctx, keys.bedWards), String(wardId));
  for (const [wardId, c] of truth) {
    m.hSet(key(ctx, keys.bedWard(wardId)), { free: c.free, occupied: c.occupied });
    m.sAdd(key(ctx, keys.bedWards), String(wardId));
  }
  m.set(key(ctx, keys.bedReconciledAt), new Date().toISOString());
  await m.exec();
  return diffs;
}
