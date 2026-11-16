import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { pathHops, paramsPath, pgPath, shuffle, stream, type GraphParams, type PathPair, type PatientMeds, type Person, type Window } from './common';

// Generates packages/bench/params/x{N}.json from clinic_bench_x{N}: the questions both engines answer.
// Deterministic: mulberry32 seed 2026 + N, one stream per list (same PRNG as the data generator and validate.ts).
//   pnpm --filter @clinic/bench params-gen -- --scale 1 [--url postgres://…]

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: { scale: { type: 'string', default: '1' }, url: { type: 'string' }, paths: { type: 'string', default: '50' } },
});
const scale = Number(values.scale);
const seed = 2026 + scale;
const db = `clinic_bench_x${scale}`;
const url = values.url ?? `postgres://clinic:clinic@localhost:5434/${db}`;
const nPaths = Number(values.paths);
const pool = new pg.Pool({ connectionString: url, max: 4 });
const t0 = Date.now();

const FROM = '2026-05-01T00:00:00+03:00'; // = validate.ts default; data covers 2025-11-01 … 2026-10-31
const at = (days: number) => new Date(Date.parse(FROM) + days * 86_400_000).toISOString();
const windows = {
  d3: { from: new Date(FROM).toISOString(), to: at(3) },
  d14: { from: new Date(FROM).toISOString(), to: at(14) },
  d60: { from: new Date(FROM).toISOString(), to: at(60) },
} satisfies Record<string, Window>;

const inpatientsActive = async (w: Window) => (await pool.query<{ patient_id: number }>(
  `SELECT DISTINCT a.patient_id FROM admissions a
   WHERE tstzrange(a.admitted_at, a.discharged_at) && tstzrange($1, $2) ORDER BY 1`, [w.from, w.to])).rows.map((r) => r.patient_id);

// ---------- trace indexes ----------
const trace = shuffle(stream(seed, 'validate'), await inpatientsActive(windows.d14)).slice(0, 200);
const traceShort = shuffle(stream(seed, 'trace-short'), await inpatientsActive(windows.d3)).slice(0, 200);
console.log(`trace: ${trace.length} (d14), traceShort: ${traceShort.length} (d3)`);

// ---------- path pairs ----------
const d2: PathPair[] = [];
const d4: PathPair[] = [];
const rPath = stream(seed, 'paths');
for (const a of shuffle(stream(seed, 'path-sources'), trace)) {
  if (d2.length >= nPaths && d4.length >= nPaths) break;
  const { rows } = await pool.query<{ person_kind: 'patient' | 'staff'; person_id: number; hops: number }>(
    'SELECT person_kind, person_id, hops FROM fn_trace_contacts($1, $2, $3, $4, 4)', ['patient', a, windows.d14.from, windows.d14.to]);
  for (const [want, list] of [[2, d2], [4, d4]] as const) {
    const cands = rows.filter((r) => r.hops === want && r.person_kind === 'patient');
    if (list.length >= nPaths || cands.length === 0) continue;
    const b = cands[Math.floor(rPath() * cands.length)]!;
    const pair: PathPair = { a: { kind: 'patient', id: a }, b: { kind: 'patient', id: b.person_id }, dist: want, maxDepth: 6 };
    const len = pathHops(await pgPath(pool, pair, windows.d14));
    if (len !== want) throw new Error(`path ${a}→${b.person_id}: expected ${want}, fn_exposure_path gave ${len}`);
    list.push(pair);
  }
}

// unreachable: b is an inpatient admitted 7–60 days after the window, with no presence in the window at all →
// every search must exhaust maxDepth (both engines run the same bounded one-directional BFS).
const absent = (await pool.query<{ patient_id: number }>(
  `SELECT DISTINCT a.patient_id FROM admissions a
   WHERE a.admitted_at >= $2::timestamptz + interval '7 days' AND a.admitted_at < $2::timestamptz + interval '60 days'
     AND NOT EXISTS (SELECT 1 FROM v_presence v WHERE v.person_kind = 'patient' AND v.person_id = a.patient_id
                     AND v.period && tstzrange($1, $2))
   ORDER BY 1`, [windows.d14.from, windows.d14.to])).rows.map((r) => r.patient_id);
const unreachable: PathPair[] = [];
const rU = stream(seed, 'unreachable');
for (const a of trace.slice(0, nPaths)) {
  const pair: PathPair = { a: { kind: 'patient', id: a }, b: { kind: 'patient', id: absent[Math.floor(rU() * absent.length)]! }, dist: null, maxDepth: 6 };
  if (pathHops(await pgPath(pool, pair, windows.d14)) !== null) throw new Error(`unreachable pair ${a}→${pair.b.id} is connected`);
  unreachable.push(pair);
}
console.log(`paths: d2 ${d2.length}, d4 ${d4.length}, unreachable ${unreachable.length}`);

// ---------- medication sets ----------
// Weighted by real use: a medication is drawn with probability ∝ its number of prescription items (the generator's
// Zipf popularity), so sets look like real prescriptions, not uniform draws over a mostly-unused catalogue.
const pop = (await pool.query<{ id: number; n: string }>(
  'SELECT medication_id AS id, count(*) AS n FROM prescription_items GROUP BY 1 ORDER BY 1')).rows.map((r) => ({ id: r.id, n: Number(r.n) }));
const totalPop = pop.reduce((s, x) => s + x.n, 0);
const drawMed = (r: () => number) => {
  let x = r() * totalPop;
  for (const m of pop) if ((x -= m.n) < 0) return m.id;
  return pop[pop.length - 1]!.id;
};
const medSets = (k: number, n: number, section: string) => {
  const r = stream(seed, section);
  return Array.from({ length: n }, () => {
    const s = new Set<number>();
    while (s.size < k) s.add(drawMed(r));
    return [...s].sort((a, b) => a - b);
  });
};
// patient context: a prescription issued in the 14-day window; `at` = 1 day after issue (its course is running)
const rx = (await pool.query<{ patient_id: number; issued_at: Date }>(
  `SELECT DISTINCT ON (mr.patient_id) mr.patient_id, p.issued_at
   FROM prescriptions p JOIN medical_records mr ON mr.id = p.medical_record_id
   WHERE p.issued_at >= $1 AND p.issued_at < $2 ORDER BY mr.patient_id, p.issued_at`, [windows.d14.from, windows.d14.to])).rows;
const rPat = stream(seed, 'patient-meds');
const patient: PatientMeds[] = shuffle(stream(seed, 'patient-pick'), rx).slice(0, 50).map((p) => ({
  patientId: p.patient_id, at: new Date(p.issued_at.getTime() + 86_400_000).toISOString(), medicationIds: [drawMed(rPat)],
}));
const meds = { m1: medSets(1, 50, 'm1'), m5: medSets(5, 50, 'm5'), m15: medSets(15, 50, 'm15'), patient };

const params: GraphParams = {
  scale: `x${scale}`,
  db,
  seed,
  method: {
    windows: 'all windows start 2026-05-01T00:00+03:00 (the density-gate window); 3 / 14 / 60 days, half-open [from, to)',
    trace: '200 inpatients whose stay intersects the 14-day window; seeded shuffle with stream "validate" — the same 200 indexes as packages/graph/validate.ts',
    traceShort: '200 inpatients whose stay intersects the 3-day window (therefore also active in the 14- and 60-day windows) — S2 compares windows on the same persons',
    paths: `d2 / d4: for trace indexes in seeded order, PG BFS depth 4 in the 14-day window, a seeded patient at exactly 2 / 4 hops; distance re-checked with fn_exposure_path. unreachable: b = inpatient admitted 7–60 days after the window with no presence in it (fn_exposure_path empty). maxDepth 6 everywhere. ${nPaths} pairs each`,
    meds: 'm1 / m5 / m15: 50 sets of 1 / 5 / 15 distinct medications, each drawn ∝ number of prescription items (real popularity). patient: 50 patients with a prescription issued in the 14-day window, at = issue + 1 day, 1 new medication drawn the same way',
    deptMonth: 'the whole generated year and its first calendar quarter of 2026',
  },
  windows,
  trace,
  traceShort,
  paths: { d2, d4, unreachable },
  meds,
  deptMonth: [{ from: '2025-11-01', to: '2026-11-01' }, { from: '2026-01-01', to: '2026-04-01' }],
};
writeFileSync(paramsPath(`x${scale}`), JSON.stringify(params, null, 1) + '\n');
await pool.end();
console.log(`→ ${paramsPath(`x${scale}`)} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
