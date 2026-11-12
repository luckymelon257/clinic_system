import neo4j, { type Driver } from 'neo4j-driver';
import pg from 'pg';
import { createClient } from 'redis';

// Connections for the benchmark process. One Node process drives every engine (same client machine, same event
// loop, same JSON decoding cost) — the harness is identical for all engines (docs/07 §3).

export type RedisClient = ReturnType<typeof createClient>;

export interface EngineConfig {
  pgUrl: string;
  neo4jUrl: string;
  neo4jUser: string;
  neo4jPassword: string;
  redisUrl: string;
  redisPrefix: string;
  timeoutMs: number;
  poolSize: number; // ≥ max concurrency, so the pool never queues and hides latency
}

export function engineConfigFromEnv(timeoutMs: number, poolSize = 40): EngineConfig {
  const env = process.env;
  return {
    pgUrl: env.BENCH_DATABASE_URL || env.DATABASE_URL || 'postgres://clinic:clinic@localhost:5434/clinic_bench_x1',
    neo4jUrl: env.BENCH_NEO4J_URL || env.NEO4J_URL || 'bolt://localhost:7688',
    neo4jUser: env.NEO4J_USER || 'neo4j',
    neo4jPassword: env.NEO4J_PASSWORD || 'clinicneo4j',
    redisUrl: env.BENCH_REDIS_URL || 'redis://localhost:6380/5',
    redisPrefix: env.BENCH_REDIS_PREFIX || 'bench',
    timeoutMs,
    poolSize,
  };
}

/** Lazily created clients; a scenario touches only the engines it needs. */
export class Engines {
  private _pg?: pg.Pool;
  private _neo4j?: Driver;
  private _redis?: RedisClient;

  constructor(readonly config: EngineConfig) {}

  get pg(): pg.Pool {
    this._pg ??= new pg.Pool({
      connectionString: this.config.pgUrl,
      max: this.config.poolSize,
      // Same timeout as Neo4j: a query that exceeds it is recorded as `timeout` (SQLSTATE 57014)
      options: `-c statement_timeout=${this.config.timeoutMs}`,
    });
    return this._pg;
  }

  get neo4j(): Driver {
    this._neo4j ??= neo4j.driver(this.config.neo4jUrl, neo4j.auth.basic(this.config.neo4jUser, this.config.neo4jPassword), {
      maxConnectionPoolSize: this.config.poolSize,
      disableLosslessIntegers: true, // ints → JS numbers (ids and epoch ms fit in 2^53)
    });
    return this._neo4j;
  }

  /** Neo4j read in an explicit transaction with the shared timeout; all records are consumed. */
  async cypher(query: string, params: Record<string, unknown> = {}): Promise<unknown[]> {
    const session = this.neo4j.session({ defaultAccessMode: neo4j.session.READ });
    try {
      const res = await session.executeRead((tx) => tx.run(query, params), { timeout: this.config.timeoutMs });
      return res.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }

  async redis(): Promise<RedisClient> {
    if (!this._redis) {
      this._redis = createClient({ url: this.config.redisUrl });
      await this._redis.connect();
    }
    return this._redis;
  }

  /** Prefixes a Redis key or channel (every key and channel lives under the prefix, CONTRIBUTING.md). */
  key(k: string): string {
    return `${this.config.redisPrefix}:${k}`;
  }

  async close(): Promise<void> {
    await Promise.allSettled([this._pg?.end(), this._neo4j?.close(), this._redis?.quit()]);
  }
}
