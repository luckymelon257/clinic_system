import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDriver, fullEtl, neo4jConfigFromEnv, runWorker, traceContacts } from '@clinic/graph';
import type { Driver } from 'neo4j-driver';
import pg from 'pg';
import { median, quantile } from '../../src/stats';
import type { BenchContext, CustomTable, Scenario } from '../../src/types';
import { graphParams, preflight, SQL } from './common';

// S6–S8: measurements that are not a closed latency loop.

const now = () => Number(process.hrtime.bigint()) / 1e6;
const r1 = (x: number) => Math.round(x * 10) / 10;

/** A synthetic shift slot far in the future (2031+) — never inside any benchmark window; k-th slot per staff. */
const slot = (k: number) => {
  const start = Date.UTC(2031, 0, 1) + k * 2 * 3_600_000;
  return [new Date(start).toISOString(), new Date(start + 3_600_000).toISOString()];
};

async function anyStaff(pool: pg.Pool): Promise<number> {
  return (await pool.query<{ id: number }>('SELECT min(id) AS id FROM staff')).rows[0]!.id;
}

// ---------- S6 ----------
export const s6: Scenario = {
  id: 'S6',
  title: 'Ціна синхронізації: накладні витрати outbox на запис і відставання графа при 10 / 50 / 200 записів/с',
  engines: ['postgres', 'neo4j'],
  why: 'Граф — read-model, і за нього платить кожен запис у PG (тригер будує payload з v_presence і вставляє рядок outbox у тій самій транзакції). Без цієї ціни порівняння читання було б нечесним. Записом обрано вставку зміни персоналу: вона дає ребро PRESENT, тобто проходить повний шлях тригер → outbox → воркер → Neo4j. Темпи 10 / 50 / 200 записів/с — від реального навантаження лікарні (~1 запис/с для присутностей) до 200× запасу.',
  expect: 'Накладні витрати тригера — десятки відсотків від часу маленької вставки (але < 1 мс абсолютно); p95 відставання ≤ 5 с (BR-11) на всіх темпах, з ростом при 200/с через пакетування.',
  falsifiedIf: 'p95 відставання > 5 с при 50 записах/с або тригер подвоює час запису.',
  async custom(ctx) {
    await preflight(ctx);
    return [await overhead(ctx), await lag(ctx)];
  },
};

/** Same insert with and without the outbox trigger, inside transactions that are rolled back (dataset unchanged). */
async function overhead(ctx: BenchContext): Promise<CustomTable> {
  const pool = ctx.engines.pg;
  const staff = await anyStaff(pool);
  const ward = (await pool.query<{ id: number }>('SELECT min(id) AS id FROM wards')).rows[0]!.id;
  const N = 2000;
  const rows: CustomTable['rows'] = [];
  const res: Record<string, number[]> = {};
  for (const rep of [0, 1, 2]) {
    for (const mode of rep % 2 ? ['off', 'on'] : ['on', 'off']) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        if (mode === 'off') await c.query('ALTER TABLE staff_shifts DISABLE TRIGGER trg_staff_shifts_graph_outbox');
        const lat: number[] = [];
        for (let k = 0; k < N; k++) {
          const [f, t] = slot(k);
          const s = now();
          await c.query('INSERT INTO staff_shifts (staff_id, ward_id, starts_at, ends_at) VALUES ($1, $2, $3, $4)', [staff, ward, f, t]);
          lat.push(now() - s);
        }
        (res[mode] ??= []).push(...lat);
      } finally {
        await c.query('ROLLBACK'); // ALTER TABLE is transactional too
        c.release();
      }
    }
  }
  for (const mode of ['off', 'on']) {
    const s = [...res[mode]!].sort((a, b) => a - b);
    rows.push([mode === 'on' ? 'з outbox-тригером' : 'без outbox-тригера', s.length, r1(median(s) * 1000), r1(quantile(s, 0.95) * 1000), r1(quantile(s, 0.99) * 1000)]);
  }
  const p50on = Number(rows[1]![2]); const p50off = Number(rows[0]![2]);
  rows.push(['накладні витрати p50', null, `+${r1(p50on - p50off)} мкс (${r1(((p50on - p50off) / p50off) * 100)} %)`, null, null]);
  return { title: `Вставка зміни персоналу (${N} × 3 повтори в транзакції з ROLLBACK, по одній, 1 клієнт)`, columns: ['режим', 'n', 'p50, мкс', 'p95, мкс', 'p99, мкс'], rows };
}

/** Committed inserts at a fixed rate while the outbox worker runs; lag = processed_at − created_at per event. */
async function lag(ctx: BenchContext): Promise<CustomTable> {
  const pool = ctx.engines.pg;
  const staff = await anyStaff(pool);
  const ward = (await pool.query<{ id: number }>('SELECT min(id) AS id FROM wards')).rows[0]!.id;
  const ac = new AbortController();
  // Worker polls every 50 ms when idle (≤ 200 ms backoff): the same settings as `pnpm graph:sync --follow` would use for BR-11.
  const worker = runWorker({ pool, driver: ctx.engines.neo4j, signal: ac.signal, worker: 'bench-s6', idleMs: 50, maxIdleMs: 200 });
  const rows: CustomTable['rows'] = [];
  try {
    for (const rate of [10, 50, 200]) {
      const seconds = 10;
      const total = rate * seconds;
      const startId = Number((await pool.query<{ id: string }>('SELECT coalesce(max(id), 0) AS id FROM graph_outbox')).rows[0]!.id);
      const ids: number[] = [];
      const t0 = now();
      const pending: Promise<unknown>[] = [];
      for (let k = 0; k < total; k++) {
        const due = t0 + (k * 1000) / rate;
        const wait = due - now();
        if (wait > 0) await sleep(wait);
        const [f, t] = slot(k);
        pending.push(pool.query<{ id: number }>('INSERT INTO staff_shifts (staff_id, ward_id, starts_at, ends_at) VALUES ($1, $2, $3, $4) RETURNING id', [staff, ward, f, t])
          .then((r) => ids.push(r.rows[0]!.id)));
      }
      await Promise.all(pending);
      const achieved = total / ((now() - t0) / 1000);
      // wait until every event of this run is applied
      for (let w = 0; w < 600; w++) {
        const { rows: p } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM graph_outbox WHERE id > $1 AND processed_at IS NULL', [startId]);
        if (Number(p[0]!.n) === 0) break;
        await sleep(100);
      }
      const { rows: l } = await pool.query<{ ms: number }>(
        "SELECT extract(epoch FROM processed_at - created_at) * 1000 AS ms FROM graph_outbox WHERE id > $1 AND entity = 'presence' AND processed_at IS NOT NULL ORDER BY 1",
        [startId]);
      const lat = l.map((x) => Number(x.ms));
      rows.push([rate, r1(achieved), lat.length, r1(quantile(lat, 0.5)), r1(quantile(lat, 0.95)), r1(lat[lat.length - 1] ?? NaN)]);
      // clean up: the DELETE events go through the worker too, so the graph stays equal to PG
      await pool.query('DELETE FROM staff_shifts WHERE id = ANY ($1)', [ids]);
      for (let w = 0; w < 600; w++) {
        const { rows: p } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM graph_outbox WHERE processed_at IS NULL');
        if (Number(p[0]!.n) === 0) break;
        await sleep(100);
      }
    }
  } finally {
    ac.abort();
    await worker;
  }
  await preflight({ ...ctx, engines: ctx.engines }); // graph still equals PG after the writes and the cleanup
  return {
    title: 'Відставання графа (подія створена → застосована в Neo4j і підтверджена), 10 с на кожен темп',
    columns: ['записів/с', 'досягнуто/с', 'подій', 'p50, мс', 'p95, мс', 'max, мс'],
    rows,
    chart: { x: 'записів/с', y: ['p50, мс', 'p95, мс'], yLabel: 'мс' },
  };
}

// ---------- S7 ----------
export const s7: Scenario = {
  id: 'S7',
  title: 'Повний ETL PostgreSQL → Neo4j',
  engines: ['postgres', 'neo4j'],
  why: 'Початкове завантаження і відновлення графа після збою — одноразова, але реальна ціна read-model. Час по сутностях показує, що домінує (ребра PRESENT), і як ETL масштабується з даними ×1 / ×5 / ×10. UNWIND пакетами по 10 000 — компроміс між кількістю round-trip і розміром транзакції в heap 1 ГБ.',
  expect: 'Час росте приблизно лінійно з кількістю ребер; ×10 — хвилини, не години.',
  falsifiedIf: 'Надлінійне зростання (ознака відсутнього індексу при MERGE) або ×10 > 30 хв.',
  async custom(ctx) {
    const r = await fullEtl(ctx.engines.config.pgUrl, ctx.engines.neo4j, { log: ctx.log });
    const rows: CustomTable['rows'] = r.steps.map((s) => [s.entity, s.rows, r1(s.ms / 1000), s.ms > 0 ? Math.round(s.rows / (s.ms / 1000)) : null]);
    rows.push(['очистка + схема', null, r1((r.wipeMs + r.schemaMs) / 1000), null]);
    rows.push(['усього', r.steps.reduce((a, s) => a + s.rows, 0), r1(r.totalMs / 1000), null]);
    await preflight(ctx);
    return [{ title: `Повний ETL (${ctx.scale}), підтверджено подій outbox: ${r.ackedEvents}`, columns: ['сутність', 'рядків', 'с', 'рядків/с'], rows }];
  },
};

// ---------- S8 ----------
const DEFAULT_RESTART_PG = 'pg_ctlcluster 16 lab2 restart'; // compose: docker restart clinic-db
const DEFAULT_RESTART_NEO4J = 'NEO4J_HOME=/opt/lab2/neo4j-main /opt/lab2/neo4j-main/bin/neo4j restart'; // compose: docker restart clinic-neo4j

export const s8: Scenario = {
  id: 'S8',
  title: 'Холодний vs теплий старт: 20 запитів трасування глибини 3',
  engines: ['postgres', 'neo4j'],
  why: 'Усі інші сценарії міряють теплий стан (прогрів 200 ітерацій), бо так працює сервер, що вже обслуговує запити. Але після рестарту рушія кеш порожній: PG читає сторінки з диска через shared_buffers / page cache ОС, Neo4j — заповнює page cache. Обидва рушії вміщуються в RAM на ×10, тож теплий стан — це «все в пам’яті», а холодний показує ціну першого звернення. Скидання page cache ОС у контейнері може бути заборонене — тоді холодний = після рестарту рушія, а не після перезавантаження машини (записано в результат).',
  expect: 'Перший запит після рестарту в обох рушіях у рази повільніший; Neo4j страждає більше (JVM без JIT-прогріву + порожній page cache), середнє 20 холодних запитів наближається до теплого швидше в PG.',
  falsifiedIf: 'Холодний і теплий відрізняються менш ніж на 20 % (тоді кеші не грають ролі на цьому обсязі).',
  async custom(ctx) {
    const p = graphParams(ctx);
    const ids = p.trace.slice(0, 20);
    const w = p.windows.d14;
    const dropped = tryDropCaches();
    const rows: CustomTable['rows'] = [];
    for (const engine of ['postgres', 'neo4j'] as const) {
      execSync(engine === 'postgres' ? process.env.BENCH_RESTART_PG || DEFAULT_RESTART_PG : process.env.BENCH_RESTART_NEO4J || DEFAULT_RESTART_NEO4J, { stdio: 'ignore', shell: '/bin/bash' });
      if (dropped) tryDropCaches();
      const run = engine === 'postgres' ? await pgRunner(ctx) : await neoRunner();
      try {
        const cold: number[] = [];
        for (const id of ids) { const s = now(); await run.trace(id, w); cold.push(now() - s); }
        const warm: number[] = [];
        for (const id of ids) { const s = now(); await run.trace(id, w); warm.push(now() - s); }
        const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
        rows.push([engine === 'postgres' ? 'pg-bfs' : 'neo4j', r1(cold[0]!), r1(mean(cold)), r1(mean(warm)), r1(mean(cold) / mean(warm))]);
      } finally {
        await run.close();
      }
    }
    return [{
      title: `Холодний (одразу після рестарту рушія${dropped ? ' і скидання page cache ОС' : '; page cache ОС не скинуто — немає прав'}) vs теплий (той самий набір удруге), ${ctx.scale}`,
      columns: ['рушій', '1-й запит, мс', 'холодні 20, середнє мс', 'теплі 20, середнє мс', 'холодний / теплий'],
      rows,
    }];
  },
};

function tryDropCaches(): boolean {
  try {
    execSync('sync && echo 3 > /proc/sys/vm/drop_caches', { stdio: 'ignore', shell: '/bin/bash' });
    return true;
  } catch {
    return false;
  }
}

async function pgRunner(ctx: BenchContext) {
  let client: pg.Client | null = null;
  for (let k = 0; k < 120 && !client; k++) {
    const c = new pg.Client({ connectionString: ctx.engines.config.pgUrl });
    try { await c.connect(); await c.query('SELECT 1'); client = c; } catch { await c.end().catch(() => {}); await sleep(500); }
  }
  if (!client) throw new Error('PostgreSQL did not come back after restart');
  const c = client;
  return {
    trace: (id: number, w: { from: string; to: string }) => c.query(SQL.traceBfs, ['patient', id, w.from, w.to, 3]),
    close: () => c.end(),
  };
}

async function neoRunner() {
  const cfg = { ...neo4jConfigFromEnv(), url: process.env.BENCH_NEO4J_URL || process.env.NEO4J_URL || 'bolt://localhost:7688' };
  let driver: Driver | null = null;
  for (let k = 0; k < 240 && !driver; k++) {
    const d = createDriver(cfg, 4);
    try { await d.verifyConnectivity(); driver = d; } catch { await d.close().catch(() => {}); await sleep(500); }
  }
  if (!driver) throw new Error('Neo4j did not come back after restart');
  const d = driver;
  return {
    trace: (id: number, w: { from: string; to: string }) => traceContacts(d, { kind: 'patient', id, from: w.from, to: w.to, depth: 3 }, 60_000),
    close: () => d.close(),
  };
}
