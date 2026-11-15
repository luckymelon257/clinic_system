import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admissionsByDeptMonth, drugInteractions, exposurePath, graphCounts, traceContacts } from '../../neo4j/queries';
import { fullEtl } from '../../sync/etl';
import { expected, loadGolden, PG_URL, testDriver } from './helpers';

// Golden gate (W0 fixture, answers computed by hand before any engine code): Neo4j must reproduce expected.json.
const driver = testDriver();
let etlAcked = 0;

beforeAll(async () => {
  await loadGolden();
  etlAcked = (await fullEtl(PG_URL, driver)).ackedEvents;
});
afterAll(() => driver.close());

const personKey = (x: { kind: string; id: number; hops: number }) => `${x.kind}:${x.id}:${x.hops}`;
const rowKey = (x: { a: number; b: number; severity: string; via: string; classA: number | null; classB: number | null }) =>
  `${x.a}-${x.b} ${x.severity} ${x.via} ${x.classA}/${x.classB}`;

describe('golden fixture on Neo4j', () => {
  it('node / relationship counts = expected.json = v_graph_counts', async () => {
    const got = await graphCounts(driver);
    const c = new pg.Client({ connectionString: PG_URL });
    await c.connect();
    const pgRows = (await c.query<{ kind: string; label: string; count: string }>('SELECT kind, label, count FROM v_graph_counts')).rows;
    await c.end();
    for (const r of got) {
      const exp = (expected.counts as Record<string, Record<string, number>>)[r.kind]![r.label];
      expect(r.count, `${r.kind} ${r.label} vs expected.json`).toBe(exp);
      expect(r.count, `${r.kind} ${r.label} vs v_graph_counts`).toBe(Number(pgRows.find((p) => p.kind === r.kind && p.label === r.label)!.count));
    }
  });

  it('full ETL acknowledged every outbox event of its snapshot', async () => {
    expect(etlAcked).toBeGreaterThan(0);
    const c = new pg.Client({ connectionString: PG_URL });
    await c.connect();
    const { rows } = await c.query<{ pending: number }>('SELECT pending FROM v_graph_sync_status');
    await c.end();
    expect(rows[0]!.pending).toBe(0);
  });

  it.each(expected.trace.map((t) => [t.name, t] as const))('trace %s', async (_, t) => {
    const got = await traceContacts(driver, { kind: t.index.kind, id: t.index.id, from: t.from, to: t.to, depth: t.depth });
    expect(got.map(personKey).sort()).toEqual(t.expected.map(personKey).sort());
    for (const c of got) {
      // the witness edge is a real hop of the BFS tree: parent is the index person or reached one hop earlier
      const parentHops = c.parentKind === t.index.kind && c.parentId === t.index.id ? 0
        : got.find((x) => x.kind === c.parentKind && x.id === c.parentId)?.hops;
      expect(parentHops, `${c.kind}:${c.id} parent`).toBe(c.hops - 1);
      expect(c.overlapMinutes).toBeGreaterThan(0);
    }
  });

  it.each(expected.path.map((q) => [q.name, q] as const))('path %s', async (_, q) => {
    const got = await exposurePath(driver, { aKind: q.a.kind, aId: q.a.id, bKind: q.b.kind, bId: q.b.id, from: q.from, to: q.to, maxDepth: q.maxDepth });
    expect(got?.hops ?? null).toBe(q.length);
    if (got) {
      expect(got.steps).toHaveLength(2 * got.hops + 1);
      expect(got.steps[0]).toMatchObject({ type: 'person', kind: q.a.kind, id: q.a.id });
      expect(got.steps.at(-1)).toMatchObject({ type: 'person', kind: q.b.kind, id: q.b.id });
      for (const s of got.steps) if (s.type === 'place') expect(Date.parse(s.from)).toBeLessThan(Date.parse(s.to));
    }
  });

  it.each(expected.interactions.map((q) => [q.name, q] as const))('interactions %s', async (_, q) => {
    const got = await drugInteractions(driver, { medicationIds: q.medicationIds, patientId: q.patientId, at: q.at });
    expect(got.map(rowKey).sort()).toEqual(q.expected.map(rowKey).sort());
  });

  it('admissions per department per month (flat aggregate for S5)', async () => {
    const got = await admissionsByDeptMonth(driver, { from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' });
    // fixture: A1–A5, A7–A10 in March (dept 1 wards W1/W2: A1–A5, A9, A10; dept 2 W3: A7, A8), A6 in February (dept 2)
    expect(got).toEqual([
      { departmentId: 1, month: '2026-03', admissions: 7 },
      { departmentId: 2, month: '2026-02', admissions: 1 },
      { departmentId: 2, month: '2026-03', admissions: 2 },
    ]);
  });

  it('rejects depth outside 1..5 and identical path ends before touching the database', async () => {
    await expect(traceContacts(driver, { kind: 'patient', id: 1, from: expected.window.from, to: expected.window.to, depth: 6 })).rejects.toThrow(RangeError);
    await expect(exposurePath(driver, { aKind: 'patient', aId: 1, bKind: 'patient', bId: 1, from: expected.window.from, to: expected.window.to, maxDepth: 3 })).rejects.toThrow(RangeError);
  });
});
