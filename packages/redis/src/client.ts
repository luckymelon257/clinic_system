import { createClient } from 'redis';

// One place that knows how we connect to Redis and how keys / channels are named.
// Every key AND every pub/sub channel is prefixed with REDIS_PREFIX (channels ignore the DB index, AGENTS.md).

export type RedisClient = ReturnType<typeof createClient>;

export interface RedisConfig {
  url: string; // redis://host:port/db
  prefix: string;
}

/** The handle every module function takes: a connected client + the key prefix. */
export interface RedisCtx {
  client: RedisClient;
  prefix: string;
}

export function redisConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RedisConfig {
  return { url: env.REDIS_URL || 'redis://localhost:6380/0', prefix: env.REDIS_PREFIX || 'clinic' };
}

export const key = (ctx: Pick<RedisCtx, 'prefix'>, k: string) => `${ctx.prefix}:${k}`;

/** Key schema (docs/06 §5). Module code never builds key strings by hand. */
export const keys = {
  slots: (doctorId: number, date: string) => `slots:${doctorId}:${date}`,
  revoked: (jti: string) => `auth:revoked:${jti}`,
  bedWard: (wardId: number) => `beds:ward:${wardId}`,
  bedWards: 'beds:wards',
  bedReconciledAt: 'beds:reconciled_at',
  triageQueue: 'triage:queue',
  triageEntry: (id: number) => `triage:entry:${id}`,
  triageSeq: 'triage:seq',
  icuVitals: 'icu:vitals',
  icuLatest: (bedId: number) => `icu:latest:${bedId}`,
  icuEvents: 'icu:events',
  alertsChannel: 'alerts:critical', // pub/sub channel, prefixed like a key
} as const;

/**
 * Creates a client that FAILS FAST while Redis is unreachable (no offline queue), so callers can degrade
 * (D-28) instead of hanging. Reconnects in the background with capped back-off. `connect` is awaited only
 * for `waitForReady` (scripts, tests); the API starts even when Redis is down.
 */
export async function connectRedis(config: RedisConfig, opts: { waitForReady?: boolean; onError?: (e: Error) => void } = {}): Promise<RedisCtx> {
  const client = createClient({
    url: config.url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 2_000,
      reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 5_000),
    },
  });
  let lastLogged = 0;
  client.on('error', (e: Error) => {
    if (opts.onError) return opts.onError(e);
    if (Date.now() - lastLogged > 30_000) {
      lastLogged = Date.now();
      console.warn(`[redis] ${e.message}`);
    }
  });
  const connecting = client.connect();
  if (opts.waitForReady ?? true) await connecting;
  else connecting.catch(() => {}); // keeps retrying via reconnectStrategy
  return { client, prefix: config.prefix };
}

export async function disconnectRedis(ctx: RedisCtx): Promise<void> {
  if (!ctx.client.isOpen) return;
  if (ctx.client.isReady) await ctx.client.quit().catch(() => {});
  else ctx.client.destroy(); // still reconnecting: stop the retry loop
}

export interface RedisHealth {
  status: 'up' | 'down';
  latencyMs: number | null;
  error: string | null;
}

/** PING round-trip for /api/health (F-45). */
export async function ping(ctx: RedisCtx): Promise<RedisHealth> {
  const t0 = performance.now();
  try {
    if (!ctx.client.isReady) throw new Error('not connected');
    await ctx.client.ping();
    return { status: 'up', latencyMs: Math.round((performance.now() - t0) * 100) / 100, error: null };
  } catch (e) {
    return { status: 'down', latencyMs: null, error: (e as Error).message };
  }
}

/** Deletes every key under the prefix (tests, basics demo). SCAN, never KEYS. */
export async function deleteByPrefix(ctx: RedisCtx, sub = ''): Promise<number> {
  let n = 0;
  for await (const batch of ctx.client.scanIterator({ MATCH: `${ctx.prefix}:${sub}*`, COUNT: 500 })) {
    if (batch.length) n += await ctx.client.del(batch);
  }
  return n;
}
