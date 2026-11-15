import { createDriver, neo4jConfigFromEnv } from '@clinic/graph';
import { connectRedis, disconnectRedis, redisConfigFromEnv, type RedisCtx } from '@clinic/redis';
import type { Driver } from 'neo4j-driver';
import { HttpError } from './errors';

// Lab 2 engines. PostgreSQL stays the source of truth; Neo4j (graph read-model) and Redis (operational state)
// are optional at runtime: the API starts and serves Lab 1 routes with either of them down (D-28).
// Both handles are created lazily from env, so tests can point them elsewhere (or at a closed port) first.

let driver: Driver | null = null;
let redis: Promise<RedisCtx> | null = null;

export const GRAPH_TIMEOUT_MS = Number(process.env.GRAPH_TIMEOUT_MS) || 30_000;

export function graphDriver(): Driver {
  // fail fast when Neo4j is unreachable instead of waiting for the default acquisition timeouts
  driver ??= createDriver(neo4jConfigFromEnv(), 50, { connectionTimeout: 3_000, connectionAcquisitionTimeout: 5_000, maxTransactionRetryTime: 0 });
  return driver;
}

/** Redis context; commands reject immediately while Redis is down (no offline queue). */
export function redisCtx(): Promise<RedisCtx> {
  redis ??= connectRedis(redisConfigFromEnv(), { waitForReady: false });
  return redis;
}

/** Tests / shutdown: drop the current handles (the next call re-creates them from env). */
export async function resetNoSql(): Promise<void> {
  const [d, r] = [driver, redis];
  driver = null;
  redis = null;
  await Promise.allSettled([d?.close(), r?.then(disconnectRedis)]);
}

/** Neo4j connectivity failure (refused, timeout, unavailable) — not a query bug. */
export function isGraphDown(e: unknown): boolean {
  const code = String((e as { code?: unknown })?.code ?? '');
  if (code.startsWith('Neo.ClientError') || code.startsWith('Neo.DatabaseError')) return false;
  const msg = String((e as Error)?.message ?? '');
  return ['ServiceUnavailable', 'SessionExpired', 'ECONNREFUSED'].includes(code) || /ECONNREFUSED|connect|acquisition timed out/i.test(msg);
}

/** Runs a Neo4j call; connectivity errors become 503 GRAPH_UNAVAILABLE (D-28). */
export async function onGraph<T>(fn: (d: Driver) => Promise<T>): Promise<T> {
  try {
    return await fn(graphDriver());
  } catch (e) {
    if (isGraphDown(e)) throw new HttpError('GRAPH_UNAVAILABLE', 'Графова база (Neo4j) недоступна — спробуйте пізніше');
    throw e;
  }
}

/** Runs a Redis call for the triage queue; any Redis failure becomes 503 QUEUE_UNAVAILABLE (Redis-only data). */
export async function onQueue<T>(fn: (ctx: RedisCtx) => Promise<T>): Promise<T> {
  try {
    return await fn(await redisCtx());
  } catch (e) {
    if (e instanceof HttpError || e instanceof RangeError) throw e;
    throw new HttpError('QUEUE_UNAVAILABLE', 'Черга тріажу (Redis) недоступна — спробуйте пізніше');
  }
}

/** Best-effort Redis side effect after a commit (cache DEL, counters): failure is logged, never fails the request. */
export async function afterCommit(what: string, fn: (ctx: RedisCtx) => Promise<unknown>): Promise<void> {
  try {
    await fn(await redisCtx());
  } catch (e) {
    console.warn(`[redis] ${what} skipped: ${(e as Error).message}`);
  }
}

/** 'YYYY-MM-DD' of a timestamp in the hospital time zone (the slot cache key is the date the UI asks for). */
export function localDate(ts: string | Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}
