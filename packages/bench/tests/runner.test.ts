import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { drive, interleave, isTimeout, OpTimeoutError, runVariant } from '../src/runner';
import { DEFAULT_MEASURE, type EngineOp } from '../src/types';

const base = { concurrency: 1, iterations: 50, maxMs: 10_000, minSamples: 0, timeoutMs: 1_000 };

describe('runner', () => {
  it('stops at the iteration count; indices are 0..n-1 exactly once', async () => {
    const seen: number[] = [];
    const r = await drive({ engine: 'postgres', run: async (i) => { seen.push(i); } }, { ...base, concurrency: 4 });
    expect(r.latencies).toHaveLength(50);
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it('stops on wall time, but not before minSamples', async () => {
    const slow: EngineOp = { engine: 'neo4j', run: () => sleep(30) };
    const byTime = await drive(slow, { ...base, iterations: 1_000, maxMs: 100 });
    expect(byTime.latencies.length).toBeGreaterThanOrEqual(3);
    expect(byTime.latencies.length).toBeLessThan(10);
    const floor = await drive(slow, { ...base, iterations: 1_000, maxMs: 1, minSamples: 6 });
    expect(floor.latencies).toHaveLength(6);
  });

  it('concurrency runs operations in parallel (closed loop)', async () => {
    let inFlight = 0;
    let peak = 0;
    const op: EngineOp = { engine: 'postgres', run: async () => { inFlight++; peak = Math.max(peak, inFlight); await sleep(5); inFlight--; } };
    const r = await drive(op, { ...base, concurrency: 8, iterations: 64 });
    expect(peak).toBe(8);
    expect(r.wallMs).toBeLessThan(64 * 5); // far less than sequential
  });

  it('PG statement_timeout (57014) and Neo4j tx timeout are counted as timeouts, not errors', async () => {
    expect(isTimeout(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))).toBe(true);
    expect(isTimeout({ code: 'Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration' })).toBe(true);
    expect(isTimeout(new OpTimeoutError(1))).toBe(true);
    expect(isTimeout(new Error('boom'))).toBe(false);
    const r = await drive({ engine: 'postgres', run: async (i) => { if (i % 10 === 0) throw Object.assign(new Error('t'), { code: '57014' }); } }, base);
    expect(r.timeouts).toBe(5);
    expect(r.errors).toBe(0);
    expect(r.latencies).toHaveLength(45);
  });

  it('a real error stops the run and is reported', async () => {
    const r = await drive({ engine: 'redis', run: async (i) => { if (i === 3) throw new Error('wrong answer'); } }, base);
    expect(r.errors).toBe(1);
    expect(r.firstError).toBe('wrong answer');
    expect(r.latencies.length).toBeLessThan(10);
    await expect(runVariant({ id: 'v', label: 'v', params: {}, ops: [{ engine: 'redis', run: async () => { throw new Error('bad'); } }] },
      { ...DEFAULT_MEASURE, warmupIterations: 0, minIterations: 5, repetitions: 1, concurrency: [1] })).rejects.toThrow('bad');
  });

  it('interleaves engines: every op runs first once per rotation', () => {
    expect(interleave(['pg', 'neo'], 0)).toEqual(['pg', 'neo']);
    expect(interleave(['pg', 'neo'], 1)).toEqual(['neo', 'pg']);
    expect(interleave(['a', 'b', 'c'], 2)).toEqual(['c', 'a', 'b']);
  });

  it('runVariant: warm-up then measure, per concurrency × repetition × op, same index sequence for each engine', async () => {
    const order: string[] = [];
    const idx: Record<string, number[]> = { postgres: [], neo4j: [] };
    const mk = (engine: 'postgres' | 'neo4j'): EngineOp => ({
      engine,
      setup: async () => { order.push(`setup:${engine}`); },
      run: async (i) => { idx[engine]!.push(i); },
      explain: async () => `plan ${engine}`,
      teardown: async () => { order.push(`teardown:${engine}`); },
    });
    const m = { ...DEFAULT_MEASURE, warmupIterations: 2, minIterations: 4, repetitions: 2, concurrency: [1, 2] };
    const res = await runVariant({ id: 'x1', label: 'x1', params: { depth: 3 }, ops: [mk('postgres'), mk('neo4j')] }, m);
    expect(res.runs.map((r) => `${r.concurrency}:${r.rep}:${r.label}`)).toEqual([
      '1:0:postgres', '1:0:neo4j', '1:1:neo4j', '1:1:postgres', '2:0:postgres', '2:0:neo4j', '2:1:neo4j', '2:1:postgres',
    ]);
    expect(res.runs.every((r) => r.n === 4 && r.ok === 4)).toBe(true);
    expect(idx.postgres!.slice(0, 6)).toEqual([0, 1, 0, 1, 2, 3]); // warm-up 0..1, measure 0..3
    expect(idx.neo4j!.slice(0, 6)).toEqual([0, 1, 0, 1, 2, 3]);
    expect(res.explain).toEqual({ postgres: 'plan postgres', neo4j: 'plan neo4j' });
    expect(order).toEqual(['setup:postgres', 'setup:neo4j', 'teardown:postgres', 'teardown:neo4j']);
  });
});
