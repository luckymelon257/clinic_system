import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadResults, mergeResults, saveResults } from '../src/bench';
import { aggregate, renderReport } from '../src/report';
import { DEFAULT_MEASURE, type BenchResults, type RunStats } from '../src/types';

const run = (label: string, concurrency: number, rep: number, p50: number, extra: Partial<RunStats> = {}): RunStats => ({
  engine: label === 'neo4j' ? 'neo4j' : 'postgres', label, concurrency, rep, n: 100, ok: 100, timeouts: 0, errors: 0,
  firstError: null, wallMs: 1000, throughput: 100, min: p50 / 2, mean: p50, p50, p95: p50 * 2, p99: p50 * 3, max: p50 * 4, ...extra,
});

const results: BenchResults = {
  schema: 1, runId: 'test', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z', scale: 'x1',
  paramsFile: 'params/x1.json', paramsSha256: 'abc', git: { commit: 'deadbeef', dirty: false }, environment: { client: { node: 'v22' } },
  scenarios: [{
    id: 'S1', title: 'trace', why: 'w', expect: 'e', falsifiedIf: 'f', measure: DEFAULT_MEASURE, error: null,
    variants: [{
      id: 'd1', label: 'depth 1', params: { depth: 1 }, explain: { 'pg-cte': 'Seq Scan' },
      runs: [run('pg-cte', 1, 0, 4), run('pg-cte', 1, 1, 6), run('pg-cte', 1, 2, 5), run('neo4j', 1, 0, 2), run('neo4j', 1, 1, 2), run('neo4j', 1, 2, 3),
        run('pg-cte', 8, 0, 9), run('neo4j', 8, 0, 3, { timeouts: 2, p99: Infinity, max: Infinity })],
    }],
    tables: [{ title: 'lag', columns: ['writes/s', 'p95 lag, ms'], rows: [[10, 120], [50, 300]], chart: { x: 'writes/s', y: ['p95 lag, ms'], yLabel: 'ms' } }],
  }],
};

describe('report', () => {
  it('aggregates repetitions by median and keeps the spread', () => {
    const a = aggregate(results.scenarios[0]!.variants[0]!.runs).find((x) => x.label === 'pg-cte' && x.concurrency === 1)!;
    expect(a).toMatchObject({ reps: 3, p50: 5, p50min: 4, p50max: 6, n: 300 });
  });

  it('renders tables, ratios, plans, timeouts and SVG charts', () => {
    const { markdown, files } = renderReport(results);
    expect(markdown).toContain('## S1 — trace');
    expect(markdown).toContain('**Спростовано, якщо:** f');
    expect(markdown).toContain('| 1 | pg-cte | 5.00 | 4.00–6.00 |');
    expect(markdown).toContain('c=1: pg-cte / neo4j = 2.50×');
    expect(markdown).toMatch(/\| 8 \| neo4j \| 3\.00 .*\| timeout \| timeout \| .* \| \*\*2\*\* \|/);
    expect(markdown).toContain('<summary>План: pg-cte</summary>');
    expect(markdown).toContain('SHA-256 `abc`');
    expect(Object.keys(files).sort()).toEqual(['charts/S1-p50.svg', 'charts/S1-t1.svg', 'charts/S1-throughput.svg']);
    for (const svg of Object.values(files)) {
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain('<title>'); // hover values
    }
  });

  it('results JSON round-trips Infinity', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'bench-')), 'r.json');
    saveResults(file, results);
    const back = loadResults(file);
    expect(back.scenarios[0]!.variants[0]!.runs[7]!.p99).toBe(Infinity);
  });

  it('merges step files of a resumable run per scenario and refuses different params', () => {
    const s1 = results.scenarios[0]!;
    const a = { ...results, startedAt: '2026-01-01T00:00:00Z', scenarios: [{ ...s1, variants: [s1.variants[0]!], tables: [] }] };
    const b = { ...results, startedAt: '2026-01-02T00:00:00Z', finishedAt: '2026-01-02T01:00:00Z', scenarios: [{ ...s1, variants: [{ ...s1.variants[0]!, id: 'd2' }], tables: [] }] };
    const m = mergeResults([a, b]);
    expect(m.scenarios).toHaveLength(1);
    expect(m.scenarios[0]!.variants.map((v) => v.id)).toEqual(['d1', 'd2']);
    expect([m.startedAt, m.finishedAt]).toEqual(['2026-01-01T00:00:00Z', '2026-01-02T01:00:00Z']);
    expect(() => mergeResults([a, { ...b, paramsSha256: 'other' }])).toThrow(/params hash/);
  });
});
