import { afterAll, describe, expect, it } from 'vitest';
import { captureEnvironment } from '../src/env';
import { Engines, engineConfigFromEnv } from '../src/engines';
import { runVariant } from '../src/runner';
import { DEFAULT_MEASURE } from '../src/types';

// Harness smoke on the real engines (PG :5434, Neo4j :7688, Redis :6380 — `pnpm nosql:up`).
const engines = new Engines({ ...engineConfigFromEnv(5_000, 8), pgUrl: process.env.BENCH_DATABASE_URL || 'postgres://clinic:clinic@localhost:5434/postgres' });
afterAll(() => engines.close());

describe('engines (live)', () => {
  it('captures engine versions and the settings that matter', async () => {
    const env = await captureEnvironment(engines, new Set(['postgres', 'neo4j', 'redis'] as const));
    const pg = env.postgres as { settings: Record<string, string> };
    expect(pg.settings.jit).toBe('off');
    expect(pg.settings).toHaveProperty('work_mem');
    const neo = env.neo4j as { components: { versions: string[] }[]; settings: Record<string, string> };
    expect(neo.components[0]!.versions[0]).toMatch(/^5\.26\./);
    expect(neo.settings).toHaveProperty('server.memory.pagecache.size');
    const redis = env.redis as { version: string; config: Record<string, string> };
    expect(redis.version).toMatch(/^7\.4\./);
    expect(redis.config['maxmemory-policy']).toBe('noeviction');
  });

  it('measures one trivial op per engine and records PG statement_timeout as timeout', async () => {
    const r = await engines.redis();
    const res = await runVariant({
      id: 'ping', label: 'ping', params: {},
      ops: [
        { engine: 'postgres', run: () => engines.pg.query('SELECT 1') },
        { engine: 'neo4j', run: () => engines.cypher('RETURN 1 AS x') },
        { engine: 'redis', run: () => r.ping() },
      ],
    }, { ...DEFAULT_MEASURE, warmupIterations: 5, minIterations: 20, repetitions: 1, concurrency: [1, 4] });
    expect(res.runs).toHaveLength(6);
    expect(res.runs.every((x) => x.ok === 20 && x.p50 > 0)).toBe(true);

    const slow = await runVariant({ id: 'slow', label: 'slow', params: {}, ops: [{ engine: 'postgres', run: () => engines.pg.query('SELECT pg_sleep(6)') }] },
      { ...DEFAULT_MEASURE, warmupIterations: 0, minIterations: 1, minSamples: 1, repetitions: 1, concurrency: [1], timeoutMs: 5_000 });
    expect(slow.runs[0]).toMatchObject({ timeouts: 1, errors: 0, p50: Infinity });
  });
});
