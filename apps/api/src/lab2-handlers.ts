import type { EngineHealth, Health, IcuAlert, RouteOutput } from '@clinic/contracts';
import { syncStatus } from '@clinic/graph';
import { countsFromPg, latestVitals, ping, readCounts, reconcile, reconciledAt, triageAdd, triageCallNext, triageList } from '@clinic/redis';
import { revocations } from './auth';
import { reads } from './db/UnitOfWork';
import { pool } from './db/pool';
import { HttpError } from './errors';
import type { Ctx } from './handlers';
import { graphDriver, onQueue, redisCtx } from './nosql';
import { GraphService } from './services/GraphService';

type Lab2Route =
  | 'logout' | 'health' | 'traceContacts' | 'exposurePath' | 'checkInteractions' | 'triageList' | 'triageAdd'
  | 'triageCallNext' | 'bedCounts' | 'icuBeds' | 'icuAlerts' | 'icuStream';

const ms = (t0: number) => Math.round((performance.now() - t0) * 100) / 100;
const down = (e: unknown): EngineHealth => ({ status: 'down', latencyMs: null, error: e instanceof Error ? e.message : String(e) });

async function pgHealth(): Promise<EngineHealth> {
  const t0 = performance.now();
  try {
    await pool.query('SELECT 1');
    return { status: 'up', latencyMs: ms(t0), error: null };
  } catch (e) {
    return down(e);
  }
}

async function neo4jHealth(): Promise<EngineHealth> {
  const t0 = performance.now();
  try {
    const s = graphDriver().session();
    try {
      await s.run('RETURN 1');
    } finally {
      await s.close();
    }
    return { status: 'up', latencyMs: ms(t0), error: null };
  } catch (e) {
    return down(e);
  }
}

export const lab2Handlers: { [N in Lab2Route]: (ctx: Ctx<N>) => Promise<RouteOutput<N>> } = {
  /** F-45: never throws — every engine reports up / down; PG down = down, Neo4j or Redis down = degraded. */
  async health() {
    const [postgres, neo4j, redis] = await Promise.all([pgHealth(), neo4jHealth(), redisCtx().then(ping, down)]);
    let graphSync: Health['graphSync'] = { pending: null, lagMs: null, lastProcessedAt: null };
    if (postgres.status === 'up') {
      try {
        const s = await syncStatus(pool);
        graphSync = { pending: s.pending, lagMs: Math.round(s.lagMs), lastProcessedAt: s.lastProcessedAt };
      } catch {
        /* status view missing → nulls */
      }
    }
    const status = postgres.status === 'down' ? 'down' : neo4j.status === 'up' && redis.status === 'up' ? 'up' : 'degraded';
    return { status, postgres, neo4j, redis, graphSync, checkedAt: new Date().toISOString() };
  },

  /** F-42 / BR-16: SET auth:revoked:<jti> 1 EX <remaining ttl>; Redis down → this process still rejects it (D-28). */
  async logout({ token }) {
    if (token.jti) {
      const ttl = token.exp ? token.exp - Math.floor(Date.now() / 1000) : 8 * 3600;
      await (await revocations()).revoke(token.jti, Math.max(1, ttl));
    }
    return { ok: true as const };
  },

  traceContacts: ({ query }) => GraphService.trace(query),
  exposurePath: ({ query }) => GraphService.path(query),
  checkInteractions: ({ body }) => GraphService.interactions(body),

  // ---------- triage: Redis only (BR-14); Redis down → 503 QUEUE_UNAVAILABLE ----------
  triageList: () => onQueue(async (ctx) => ({ ...(await triageList(ctx)), source: 'redis' as const })),
  triageAdd: ({ body }) => onQueue((ctx) => triageAdd(ctx, body)),
  triageCallNext: () => onQueue((ctx) => triageCallNext(ctx)),

  /** F-43: Redis counters (reconciled from v_beds), PG when Redis is down. */
  async bedCounts() {
    const wards = await reads.lab2.wards();
    let source: 'redis' | 'postgres' = 'redis';
    let counts: Map<number, { free: number; occupied: number }>;
    let at: string | null = null;
    try {
      const ctx = await redisCtx();
      counts = await readCounts(ctx);
      if (counts.size === 0) {
        await reconcile(ctx, pool); // first use after a Redis restart
        counts = await readCounts(ctx);
      }
      at = await reconciledAt(ctx);
    } catch {
      source = 'postgres';
      counts = await countsFromPg(pool);
    }
    return {
      items: wards.map((w) => ({ ...w, free: counts.get(w.wardId)?.free ?? 0, occupied: counts.get(w.wardId)?.occupied ?? 0 })),
      source,
      reconciledAt: at,
    };
  },

  /** F-44: ICU beds with the latest reading from Redis (null when the monitor is silent or Redis is down). */
  async icuBeds() {
    const beds = await reads.lab2.icuBeds();
    let latest = new Map<number, Awaited<ReturnType<typeof latestVitals>> extends Map<number, infer V> ? V : never>();
    try {
      latest = await latestVitals(await redisCtx(), beds.map((b) => b.bedId));
    } catch {
      /* Redis down: no live data */
    }
    return beds.map((b) => {
      const v = latest.get(b.bedId) ?? null;
      return {
        ...b,
        vitals: v ? { hr: v.hr, spo2: v.spo2, sbp: v.sbp, dbp: v.dbp, rr: v.rr, temp: v.temp, at: v.at } : null,
        alerting: v?.alerting ?? false,
      };
    });
  },

  /** Persisted alerts (PG icu_alerts, written by the stream consumer group). */
  async icuAlerts({ query }) {
    const rows = await reads.lab2.icuAlerts(query.limit, query.bedId);
    return rows.map(
      (r): IcuAlert => ({
        id: r.streamId,
        bedId: r.bedId,
        patientId: r.patientId,
        patientName: r.patientName,
        violations: r.violations,
        vitals: { ...r.vitals, at: new Date(r.vitals.at).toISOString() },
        at: new Date(r.at).toISOString(),
      }),
    );
  },

  /** Served by the SSE handler in sse.ts (registered before the generic JSON routes). */
  async icuStream() {
    throw new HttpError('INTERNAL', 'icuStream is served as text/event-stream');
  },
};
