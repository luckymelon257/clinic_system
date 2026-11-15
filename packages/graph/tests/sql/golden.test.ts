import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expected, GRAPH_TEST_URL, loadGolden } from './db';

// Golden gate (W0 fixture, hand-computed expected.json) for the PostgreSQL implementation (migration 010).
let pool: pg.Pool;
beforeAll(async () => {
  await loadGolden();
  pool = new pg.Pool({ connectionString: GRAPH_TEST_URL, max: 2 });
});
afterAll(() => pool?.end());

type Row = { kind: string; id: number; hops: number };
const key = (r: Row) => `${r.kind}:${r.id}:${r.hops}`;
const sorted = (xs: string[]) => [...xs].sort();

describe('golden: trace', () => {
  for (const c of expected.trace) {
    const want = sorted(c.expected.map(key));
    const args = [c.index.kind, c.index.id, c.from, c.to, c.depth];
    it(`CTE ${c.name}`, async () => {
      const { rows } = await pool.query<Row>(
        'SELECT person_kind AS kind, person_id AS id, hops FROM fn_trace_contacts_cte($1, $2, $3, $4, $5)', args);
      expect(sorted(rows.map(key))).toEqual(want);
    });
    it(`BFS ${c.name}`, async () => {
      const { rows } = await pool.query<Row & { exposure: string; overlap_minutes: string }>(
        'SELECT person_kind AS kind, person_id AS id, hops, exposure, overlap_minutes FROM fn_trace_contacts($1, $2, $3, $4, $5)', args);
      expect(sorted(rows.map(key))).toEqual(want);
      for (const r of rows) {
        expect(['room', 'ward', 'office']).toContain(r.exposure);
        expect(Number(r.overlap_minutes)).toBeGreaterThan(0);
      }
    });
  }

  it('BFS witness edges: room preferred over ward, overlap clipped to the window', async () => {
    const { rows } = await pool.query(
      `SELECT person_kind, person_id, parent_kind, parent_id, exposure, place_id, overlap_minutes
       FROM fn_trace_contacts('patient', 1, '2026-03-01T00:00Z', '2026-03-15T00:00Z', 1) ORDER BY person_kind, person_id`);
    expect(rows).toEqual([
      // P2 shares room R11 with P1 over [03-04, 03-06) = 2 days
      { person_kind: 'patient', person_id: 2, parent_kind: 'patient', parent_id: 1, exposure: 'room', place_id: 1, overlap_minutes: '2880.0' },
      // P3 shares only ward W1 over [03-05, 03-06)
      { person_kind: 'patient', person_id: 3, parent_kind: 'patient', parent_id: 1, exposure: 'ward', place_id: 1, overlap_minutes: '1440.0' },
      // S3 shift 03-05 08:00–20:00 inside P1's stay
      { person_kind: 'staff', person_id: 3, parent_kind: 'patient', parent_id: 1, exposure: 'ward', place_id: 1, overlap_minutes: '720.0' },
    ]);
    const open = await pool.query(
      `SELECT overlap_minutes FROM fn_trace_contacts('patient', 3, '2026-03-12T00:00Z', '2026-03-15T00:00Z', 1)`);
    expect(open.rows).toEqual([{ overlap_minutes: '480.0' }]); // S1 08:00–16:00, P3 open stay
  });
});

describe('golden: exposure path', () => {
  for (const c of expected.path) {
    it(c.name, async () => {
      const { rows } = await pool.query<{ step: number; step_type: string; kind: string; id: number; f: Date | null; t: Date | null }>(
        'SELECT * FROM fn_exposure_path($1, $2, $3, $4, $5, $6, $7)', [c.a.kind, c.a.id, c.b.kind, c.b.id, c.from, c.to, c.maxDepth]);
      const persons = rows.filter((r) => r.step_type === 'person');
      expect(persons.length ? persons.length - 1 : null).toBe(c.length);
      if (c.length === null) return;
      // alternating person / place, from A to B, place intervals non-empty and inside the window
      expect(rows.map((r) => r.step)).toEqual(rows.map((_, i) => i));
      expect(rows.map((r) => r.step_type)).toEqual(rows.map((_, i) => (i % 2 ? 'place' : 'person')));
      expect([rows[0]!.kind, rows[0]!.id]).toEqual([c.a.kind, c.a.id]);
      expect([rows.at(-1)!.kind, rows.at(-1)!.id]).toEqual([c.b.kind, c.b.id]);
      for (const p of rows.filter((r) => r.step_type === 'place')) {
        expect(p.f!.getTime()).toBeLessThan(p.t!.getTime());
        expect(p.f!.getTime()).toBeGreaterThanOrEqual(Date.parse(c.from));
        expect(p.t!.getTime()).toBeLessThanOrEqual(Date.parse(c.to));
      }
    });
  }
});

describe('golden: drug interactions', () => {
  type I = { a: number; b: number; severity: string; via: string; classA: number | null; classB: number | null };
  const ikey = (r: I) => `${r.a}-${r.b}-${r.severity}-${r.via}-${r.classA}-${r.classB}`;
  for (const c of expected.interactions) {
    it(c.name, async () => {
      const { rows } = await pool.query<I>(
        `SELECT medication_a AS a, medication_b AS b, severity::text, via, class_a AS "classA", class_b AS "classB"
         FROM fn_drug_interactions($1, $2, $3)`, [c.medicationIds, c.patientId, c.at]);
      expect(sorted(rows.map(ikey))).toEqual(sorted(c.expected.map(ikey)));
    });
  }

  it('active medications of P2', async () => {
    const at = async (ts: string) =>
      (await pool.query<{ medication_id: number }>('SELECT medication_id FROM fn_patient_active_medications(2, $1) ORDER BY 1', [ts])).rows
        .map((r) => r.medication_id);
    expect(await at('2026-03-05T00:00Z')).toEqual([1, 7]);
    expect(await at('2026-04-10T00:00Z')).toEqual([]);
    expect(await at('2026-03-04T10:00Z')).toEqual([1, 7]); // f <= at
    expect(await at('2026-03-07T10:00Z')).toEqual([1]); // at < t: paracetamol ends exactly now
  });
});

describe('golden: counts and S5 aggregate', () => {
  it('v_graph_counts equals the hand-computed counts', async () => {
    const { rows } = await pool.query<{ kind: 'node' | 'rel'; label: string; count: string }>('SELECT kind, label, count FROM v_graph_counts');
    const got = { node: {} as Record<string, number>, rel: {} as Record<string, number> };
    for (const r of rows) got[r.kind][r.label] = Number(r.count);
    expect(got).toEqual(expected.counts);
  });

  it('admissions by department and month', async () => {
    const { rows } = await pool.query(
      "SELECT department_id, to_char(month, 'YYYY-MM') AS month, admissions FROM fn_admissions_by_dept_month('2026-02-01', '2026-04-01')");
    expect(rows).toEqual([
      { department_id: 1, month: '2026-03', admissions: 7 }, // A1–A5, A9, A10 (W1, W2)
      { department_id: 2, month: '2026-02', admissions: 1 }, // A6
      { department_id: 2, month: '2026-03', admissions: 2 }, // A7, A8
    ]);
  });
});

describe('BR-12 validation', () => {
  const bad = (sql: string, params: unknown[], code: string) => expect(pool.query(sql, params)).rejects.toMatchObject({ code });
  it('depth, window order, window length, person kind', async () => {
    const t = 'SELECT * FROM fn_trace_contacts($1, $2, $3, $4, $5)';
    const c = 'SELECT * FROM fn_trace_contacts_cte($1, $2, $3, $4, $5)';
    for (const q of [t, c]) {
      await bad(q, ['patient', 1, '2026-03-01', '2026-03-15', 6], 'P0080');
      await bad(q, ['patient', 1, '2026-03-01', '2026-03-15', 0], 'P0080');
      await bad(q, ['patient', 1, '2026-03-15', '2026-03-01', 2], 'P0081');
      await bad(q, ['patient', 1, '2026-01-01', '2026-04-02', 2], 'P0082');
      await bad(q, ['doctor', 1, '2026-03-01', '2026-03-15', 2], 'P0083');
    }
    await bad('SELECT * FROM fn_exposure_path($1, $2, $3, $4, $5, $6, $7)', ['patient', 1, 'patient', 8, '2026-03-01', '2026-03-15', 9], 'P0080');
    const ok = await pool.query(t, ['patient', 1, '2026-01-01T00:00Z', '2026-04-01T00:00Z', 1]); // exactly 90 days
    expect(ok.rowCount).toBeGreaterThan(0);
  });
});
