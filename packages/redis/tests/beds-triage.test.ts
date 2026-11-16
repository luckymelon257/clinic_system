import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { key, keys, type RedisCtx } from '../src/client';
import { applyBedChange, countsFromPg, readCounts, reconcile, reconciledAt } from '../src/beds';
import { triageAdd, triageCallNext, triageList, triageSize } from '../src/triage';
import { dropRedis, testPool, testRedis } from './helpers';

let ctx: RedisCtx;
let pool: pg.Pool;
beforeAll(async () => {
  ctx = await testRedis();
  pool = testPool();
});
afterAll(async () => {
  await dropRedis(ctx);
  await pool.end();
});

const one = async <T>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0] as T;

describe('bed counters (F-43)', () => {
  it('follow admit / transfer / discharge and equal v_beds; reconcile repairs drift', async () => {
    expect(await reconcile(ctx, pool)).toHaveLength((await countsFromPg(pool)).size); // empty Redis: every ward differs
    expect(await reconciledAt(ctx)).not.toBeNull();

    const doc = await one<{ id: number }>('SELECT id FROM doctors ORDER BY id LIMIT 1');
    const beds = (await pool.query<{ id: number; ward_id: number }>(
      "SELECT id, ward_id FROM v_beds WHERE status = 'available' ORDER BY ward_id DESC, id LIMIT 3")).rows;
    const patients = (await pool.query<{ id: number }>(
      "SELECT id FROM patients p WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM admissions a WHERE a.patient_id = p.id AND a.status = 'active') ORDER BY id LIMIT 2")).rows;
    const [b1, b2, b3] = beds as [typeof beds[0], typeof beds[0], typeof beds[0]];

    // what the API does: commit in PG, then HINCRBY
    const a1 = (await one<{ p_id: number }>('CALL sp_admit_patient($1, $2, $3, $4, NULL)', [patients[0]!.id, b1.id, doc.id, 'test'])).p_id;
    await applyBedChange(ctx, { toWardId: b1.ward_id });
    const a2 = (await one<{ p_id: number }>('CALL sp_admit_patient($1, $2, $3, $4, NULL)', [patients[1]!.id, b2.id, doc.id, 'test'])).p_id;
    await applyBedChange(ctx, { toWardId: b2.ward_id });
    await pool.query('CALL sp_transfer_patient($1, $2)', [a1, b3.id]);
    await applyBedChange(ctx, { fromWardId: b1.ward_id, toWardId: b3.ward_id });
    await pool.query('CALL sp_discharge_patient($1, $2, NULL)', [a2, 'ok']);
    await applyBedChange(ctx, { fromWardId: b2.ward_id });

    expect(await readCounts(ctx)).toEqual(await countsFromPg(pool));

    // drift (lost increment / manual damage) → reconcile reports and fixes it
    await ctx.client.hIncrBy(key(ctx, keys.bedWard(b3.ward_id)), 'free', 5);
    const diffs = await reconcile(ctx, pool);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.wardId).toBe(b3.ward_id);
    expect(await readCounts(ctx)).toEqual(await countsFromPg(pool));
  });
});

describe('triage queue (F-40, BR-14)', () => {
  it('pops by ESI, then arrival; equal score → id order', async () => {
    const t = 1_700_000_000_000;
    await triageAdd(ctx, { patientId: null, patientName: 'C esi3 early', esi: 3, complaint: 'x' }, t);
    await triageAdd(ctx, { patientId: null, patientName: 'B esi1 late', esi: 1, complaint: 'x' }, t + 5_000);
    await triageAdd(ctx, { patientId: 7, patientName: 'D esi3 late', esi: 3, complaint: 'x' }, t + 9_000);
    await triageAdd(ctx, { patientId: null, patientName: 'E esi3 late twin', esi: 3, complaint: 'x' }, t + 9_000);
    const a = await triageAdd(ctx, { patientId: null, patientName: 'A esi1 early', esi: 1, complaint: 'x' }, t + 1_000);
    expect(a.position).toBe(1);
    const list = await triageList(ctx);
    expect(list.total).toBe(5);
    expect(list.items.map((e) => e.patientName)).toEqual(['A esi1 early', 'B esi1 late', 'C esi3 early', 'D esi3 late', 'E esi3 late twin']);
    expect(list.items.map((e) => e.position)).toEqual([1, 2, 3, 4, 5]);
    expect(list.items[3]).toMatchObject({ patientId: 7, esi: 3, arrivedAt: new Date(t + 9_000).toISOString() });
    const order: string[] = [];
    for (;;) {
      const { entry } = await triageCallNext(ctx);
      if (!entry) break;
      expect(entry.position).toBe(0);
      order.push(entry.patientName);
    }
    expect(order).toEqual(list.items.map((e) => e.patientName));
    expect(await triageCallNext(ctx)).toEqual({ entry: null, remaining: 0 });
    await expect(triageAdd(ctx, { patientId: null, patientName: 'bad', esi: 6, complaint: 'x' })).rejects.toThrow('ESI');
  });

  // Exactly-once + priority under 32 concurrent consumers. Priority check: every entry popped while a strictly
  // higher-priority entry was still waiting would be a violation; at quiescence the popped set equals the queue.
  const N = 2_000;
  const CONSUMERS = 32;
  const esiOf = (i: number) => 1 + ((i * 7919) % 5);

  it('Redis ZPOPMIN: 32 consumers, no duplicates, nothing lost, each consumer sees priority order', async () => {
    const t = 1_800_000_000_000;
    for (let i = 0; i < N; i += 200) {
      await Promise.all(Array.from({ length: 200 }, (_, k) => triageAdd(ctx, { patientId: null, patientName: `p${i + k}`, esi: esiOf(i + k), complaint: 'x' }, t + i + k)));
    }
    const seen: number[] = [];
    const perConsumer: { esi: number; at: string }[][] = [];
    await Promise.all(Array.from({ length: CONSUMERS }, async (_, c) => {
      perConsumer[c] = [];
      for (;;) {
        const { entry } = await triageCallNext(ctx);
        if (!entry) return;
        seen.push(entry.id);
        perConsumer[c]!.push({ esi: entry.esi, at: entry.arrivedAt });
      }
    }));
    expect(seen).toHaveLength(N);
    expect(new Set(seen).size).toBe(N);
    expect(await triageSize(ctx)).toBe(0);
    for (const list of perConsumer) {
      for (let k = 1; k < list.length; k++) {
        const [a, b] = [list[k - 1]!, list[k]!];
        expect(a.esi < b.esi || (a.esi === b.esi && a.at <= b.at)).toBe(true);
      }
    }
  });

  it('PG reference FOR UPDATE SKIP LOCKED: 32 consumers, no duplicates, nothing lost, priority order', async () => {
    await pool.query('TRUNCATE triage_queue_pg');
    await pool.query(`INSERT INTO triage_queue_pg (patient_name, esi, complaint, arrived_at)
      SELECT 'p' || i, 1 + (i * 7919) % 5, 'x', timestamptz '2030-01-01' + i * interval '1 ms' FROM generate_series(0, $1 - 1) i`, [N]);
    const seen: number[] = [];
    const perConsumer: { esi: number; at: Date }[][] = [];
    await Promise.all(Array.from({ length: CONSUMERS }, async (_, c) => {
      perConsumer[c] = [];
      const client = await pool.connect();
      try {
        for (;;) {
          const { rows } = await client.query<{ id: string; esi: number; arrived_at: Date }>('SELECT id, esi, arrived_at FROM fn_triage_pop()');
          if (!rows[0]) return;
          seen.push(Number(rows[0].id));
          perConsumer[c]!.push({ esi: rows[0].esi, at: rows[0].arrived_at });
        }
      } finally {
        client.release();
      }
    }));
    expect(seen).toHaveLength(N);
    expect(new Set(seen).size).toBe(N);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM triage_queue_pg WHERE called_at IS NULL')).n).toBe(0);
    for (const list of perConsumer) {
      for (let k = 1; k < list.length; k++) {
        const [a, b] = [list[k - 1]!, list[k]!];
        expect(a.esi < b.esi || (a.esi === b.esi && a.at <= b.at)).toBe(true);
      }
    }
  });
});
