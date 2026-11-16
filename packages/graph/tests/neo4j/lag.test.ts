import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { quantile } from '../../sync/stats';
import { fullEtl } from '../../sync/etl';
import { runWorker, syncStatus } from '../../sync/worker';
import { loadGolden, PG_URL, testDriver } from './helpers';

// BR-11: with the worker running, PG → Neo4j lag (event created_at → acknowledged) stays ≤ 5 s at p95.
// Load: 50 writes/s for 4 s, alternating a presence source (new staff shift) and a node change (patient rename).
const driver = testDriver();
const pool = new pg.Pool({ connectionString: PG_URL, max: 4 });
const RATE = 50;
const SECONDS = 4;

beforeAll(async () => {
  await loadGolden();
  await fullEtl(PG_URL, driver);
});
afterAll(async () => {
  await pool.end();
  await driver.close();
});

describe('sync lag', () => {
  it(`p95 lag ≤ 5 s at ${RATE} writes/s`, async () => {
    const start = Number((await pool.query<{ id: string }>('SELECT coalesce(max(id), 0) AS id FROM graph_outbox')).rows[0]!.id);
    const ac = new AbortController();
    const worker = runWorker({ pool, driver, signal: ac.signal, worker: 'lag-test' });

    const n = RATE * SECONDS;
    const t0 = Date.now();
    const writes: Promise<unknown>[] = [];
    for (let k = 0; k < n; k++) {
      const due = t0 + (k * 1000) / RATE;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      writes.push(k % 2
        ? pool.query("UPDATE patients SET first_name = 'P' || $1 WHERE id = $2", [k, 1 + (k % 12)])
        : pool.query('CALL sp_staff_shift_add(3, 1, $1, $2, NULL)', [new Date(Date.UTC(2027, 0, 1) + k * 3_600_000), new Date(Date.UTC(2027, 0, 1) + k * 3_600_000 + 1_800_000)]));
    }
    await Promise.all(writes);
    const elapsed = (Date.now() - t0) / 1000;

    const deadline = Date.now() + 30_000;
    while ((await syncStatus(pool)).pending > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    await worker;

    const lags = (await pool.query<{ ms: string }>(
      'SELECT extract(epoch FROM processed_at - created_at) * 1000 AS ms FROM graph_outbox WHERE id > $1 AND processed_at IS NOT NULL ORDER BY 1', [start]))
      .rows.map((r) => Number(r.ms));
    expect(lags).toHaveLength(n);
    const p50 = quantile(lags, 0.5);
    const p95 = quantile(lags, 0.95);
    console.log(`sync lag: ${n} events in ${elapsed.toFixed(1)} s (${(n / elapsed).toFixed(0)} w/s) → p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, max ${lags.at(-1)!.toFixed(0)} ms`);
    expect(p95).toBeLessThanOrEqual(5_000);
  });
});
