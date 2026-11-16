import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { key, keys, type RedisCtx } from '../src/client';
import {
  ensureAlertGroup, ingestVitals, latestVitals, pgAlertRecorder, processAlertBatch, recentAlerts, STREAM_MAXLEN,
  subscribeAlerts, type IcuAlert, type VitalsReading,
} from '../src/icu';
import { dropRedis, testPool, testRedis } from './helpers';

let ctx: RedisCtx;
let pool: pg.Pool;
let bedId = 0;
beforeAll(async () => {
  ctx = await testRedis();
  pool = testPool();
  bedId = (await pool.query<{ bed_id: number }>('SELECT bed_id FROM v_icu_beds ORDER BY bed_id LIMIT 1')).rows[0]!.bed_id;
});
afterAll(async () => {
  await dropRedis(ctx);
  await pool.end();
});

const normal = { hr: 80, spo2: 97, sbp: 120, dbp: 75, rr: 16, temp: 36.8 };
const reading = (over: Partial<VitalsReading> = {}): VitalsReading => ({ bedId, ...normal, ...over });

describe('BR-17 thresholds: Lua script = fn_icu_violations, boundaries exactly as written', () => {
  // [sign, value, alerts?] — "< 40" alerts at 39, not at 40; "> 39.5" alerts at 39.6, not at 39.5
  const cases: [keyof typeof normal, number, boolean][] = [
    ['hr', 39, true], ['hr', 40, false], ['hr', 140, false], ['hr', 141, true],
    ['spo2', 87, true], ['spo2', 87.9, true], ['spo2', 88, false],
    ['sbp', 79, true], ['sbp', 80, false], ['sbp', 200, false], ['sbp', 201, true],
    ['rr', 7, true], ['rr', 8, false], ['rr', 30, false], ['rr', 31, true],
    ['temp', 39.5, false], ['temp', 39.6, true],
    ['dbp', 20, false], ['dbp', 160, false], // no BR-17 rule for diastolic
  ];

  it.each(cases)('%s = %s → alert %s (Redis and PG agree)', async (sign, value, alerts) => {
    const r = reading({ [sign]: value });
    const { alert } = await ingestVitals(ctx, r);
    const { rows } = await pool.query<{ v: { sign: string; value: number; rule: string }[] }>(
      'SELECT fn_icu_violations($1, $2, $3, $4, $5, $6) AS v', [r.hr, r.spo2, r.sbp, r.dbp, r.rr, r.temp]);
    expect(alert !== null).toBe(alerts);
    expect(alert?.violations ?? []).toEqual(rows[0]!.v.map((x) => ({ ...x, value: Number(x.value) })));
  });

  it('several violations at once, in rule order', async () => {
    const { alert } = await ingestVitals(ctx, reading({ hr: 150, spo2: 80, temp: 40.1 }));
    expect(alert!.violations.map((v) => v.rule)).toEqual(['> 140', '< 88', '> 39.5']);
  });
});

describe('stream, latest, events', () => {
  it('latest hash per bed with TTL; events list keeps the last alerts newest first', async () => {
    const at = Date.UTC(2030, 0, 1, 12);
    const { streamId } = await ingestVitals(ctx, reading({ hr: 30, patientId: 5, atMs: at }));
    const latest = (await latestVitals(ctx, [bedId, 999_999])).get(bedId)!;
    expect(latest).toMatchObject({ hr: 30, alerting: true, at: new Date(at).toISOString() });
    expect((await latestVitals(ctx, [999_999])).get(999_999)).toBeNull();
    expect(await ctx.client.ttl(key(ctx, keys.icuLatest(bedId)))).toBeGreaterThan(290);
    const [newest] = await recentAlerts(ctx, 5);
    expect(newest).toMatchObject({ id: streamId, bedId, patientId: 5, at: new Date(at).toISOString() });
    expect(newest!.vitals.hr).toBe(30);
  });

  it('MAXLEN ~ 100000 keeps the stream bounded (approximate trimming)', async () => {
    const batch = 5_000;
    for (let sent = 0; sent < STREAM_MAXLEN + 10_000; sent += batch) {
      await Promise.all(Array.from({ length: batch }, () => ingestVitals(ctx, reading())));
    }
    const len = await ctx.client.xLen(key(ctx, keys.icuVitals));
    expect(len).toBeGreaterThanOrEqual(STREAM_MAXLEN);
    expect(len).toBeLessThan(STREAM_MAXLEN + 1_000); // '~' trims whole radix-tree nodes (≤ 100 entries each)
  }, 120_000);

  it('pub/sub delivers a critical alert in ≤ 2 s (on the prefixed channel)', async () => {
    const got: IcuAlert[] = [];
    const unsubscribe = await subscribeAlerts(ctx, (a) => got.push(a));
    try {
      const t0 = Date.now();
      const { streamId } = await ingestVitals(ctx, reading({ spo2: 80 }));
      while (!got.some((a) => a.id === streamId) && Date.now() - t0 < 2_000) await new Promise((r) => setTimeout(r, 10));
      expect(got.find((a) => a.id === streamId)?.violations[0]).toEqual({ sign: 'spo2', value: 80, rule: '< 88' });
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      await unsubscribe();
    }
  });
});

describe('consumer group → PG icu_alerts (durable, idempotent)', () => {
  it('persists each alert once; a failed write stays pending and is re-claimed; redelivery does not duplicate', async () => {
    await ctx.client.del(key(ctx, keys.icuVitals)); // start the group on a clean stream
    await ensureAlertGroup(ctx);
    await ensureAlertGroup(ctx); // BUSYGROUP is fine
    const ids = [
      (await ingestVitals(ctx, reading({ hr: 35 }))).streamId,
      (await ingestVitals(ctx, reading())).streamId,
      (await ingestVitals(ctx, reading({ rr: 40 }))).streamId,
    ];
    const count = async () => Number((await pool.query('SELECT count(*) FROM icu_alerts WHERE stream_id = ANY ($1)', [ids])).rows[0].count);

    // consumer A crashes on the first alert (DB down) → nothing ACKed for alerts
    const failing = await processAlertBatch(ctx, async () => { throw new Error('db down'); }, { consumer: 'a', blockMs: 10 });
    expect(failing).toEqual({ read: 3, recorded: 0, failed: 2 });
    expect(await count()).toBe(0);

    // consumer B re-claims the pending alerts and persists them
    const record = pgAlertRecorder(pool);
    const ok = await processAlertBatch(ctx, record, { consumer: 'b', blockMs: 10, minIdleMs: 0 });
    expect(ok.recorded).toBe(2);
    expect(await count()).toBe(2);
    const pending = await ctx.client.xPending(key(ctx, keys.icuVitals), 'alert-persister');
    expect(pending.pending).toBe(0);

    // a duplicate delivery of the same entry (e.g. ACK lost) does not create a second row
    const row = (await pool.query('SELECT stream_id, bed_id, violations, patient_name FROM v_icu_alerts WHERE stream_id = $1', [ids[0]])).rows[0];
    expect(row).toMatchObject({ stream_id: ids[0], bed_id: bedId });
    expect(row.violations).toEqual([{ sign: 'hr', value: 35, rule: '< 40' }]);
    await record({ streamId: ids[0]!, bedId, patientId: null, alert: true, violations: row.violations, vitals: { ...normal, hr: 35, at: new Date().toISOString() } });
    expect(await count()).toBe(2);
  });
});
