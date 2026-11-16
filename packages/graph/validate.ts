import { parseArgs } from 'node:util';
import { databaseUrl, withDatabase } from '@clinic/db';
import pg from 'pg';
import { shuffle, stream } from './gen/prng';

// Density gate (run before any benchmark): is the generated contact graph realistic enough that tracing numbers
// mean something? Window 14 d, 200 index inpatients active in the window (seeded choice), sizes of the reachable
// set within 1, 2, 3 and 5 hops (cumulative, index excluded), computed with fn_trace_contacts (BFS).
//   d1 p50 ∈ [30, 120] and p5 ≥ 5     — one ward + its staff, not an isolated or a fully-mixed population
//   d2 p50 ∈ [150, 1000]              — second hop must branch out, but not yet cover the hospital
//   d3 p50 ≤ 50 % of window-active    — depth still selective at 3
//   d5 saturation                     — reported (share of window-active persons reached), not gated
// Plus a correctness cross-check on real data: recursive CTE = BFS at depth 2 for the first indexes.
//
// pnpm --filter @clinic/graph validate -- --scale 1 [--samples 200] [--d5-samples 200] [--from 2026-05-01] [--days 14]

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    scale: { type: 'string', default: '1' },
    samples: { type: 'string', default: '200' },
    'd5-samples': { type: 'string' },
    'cte-samples': { type: 'string', default: '10' },
    from: { type: 'string', default: '2026-05-01T00:00:00+03:00' },
    days: { type: 'string', default: '14' },
    workers: { type: 'string', default: '4' },
    url: { type: 'string' },
  },
});

const scale = Number(values.scale);
const samples = Number(values.samples);
const d5Samples = Number(values['d5-samples'] ?? (scale === 1 ? samples : 30)); // depth 5 saturates → expensive at ×5 / ×10
const cteSamples = Number(values['cte-samples']);
const url = values.url ?? withDatabase(databaseUrl(), `clinic_bench_x${scale}`);
const from = new Date(values.from!);
const to = new Date(from.getTime() + Number(values.days) * 86_400_000);

const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
};

const pool = new pg.Pool({ connectionString: url, max: Number(values.workers) });
const t0 = Date.now();

const active = Number((await pool.query<{ n: string }>(
  'SELECT count(*) AS n FROM (SELECT DISTINCT person_kind, person_id FROM v_presence WHERE period && tstzrange($1, $2)) x', [from, to])).rows[0]!.n);
const candidates = (await pool.query<{ patient_id: number }>(
  `SELECT DISTINCT a.patient_id FROM admissions a
   WHERE tstzrange(a.admitted_at, a.discharged_at) && tstzrange($1, $2) ORDER BY 1`, [from, to])).rows.map((r) => r.patient_id);
const indexes = shuffle(stream(2026 + scale, 'validate'), candidates).slice(0, samples);

interface Sizes { id: number; d: number[]; ms: number }
const results: Sizes[] = [];
let next = 0;
async function worker() {
  for (;;) {
    const i = next++;
    if (i >= indexes.length) return;
    const id = indexes[i]!;
    const depth = i < d5Samples ? 5 : 3;
    const s = Date.now();
    const { rows } = await pool.query<{ hops: number; n: string }>(
      `SELECT hops, count(*) AS n FROM fn_trace_contacts('patient', $1, $2, $3, $4) GROUP BY hops`, [id, from, to, depth]);
    const per = [0, 0, 0, 0, 0, 0];
    for (const r of rows) per[r.hops] = Number(r.n);
    const cum = per.map((_, k) => per.slice(1, k + 1).reduce((a, b) => a + b, 0)); // cum[k] = reached within k hops
    results.push({ id, d: depth === 5 ? cum : [...cum.slice(0, 4), NaN, NaN], ms: Date.now() - s });
  }
}
await Promise.all(Array.from({ length: Number(values.workers) }, worker));

// CTE = BFS (same (person, hops) set) at depth 2 on real data
let cteOk = 0;
for (const id of indexes.slice(0, cteSamples)) {
  const sql = (fn: string) => `SELECT person_kind || ':' || person_id || ':' || hops AS k FROM ${fn}('patient', $1, $2, $3, 2) ORDER BY 1`;
  const a = (await pool.query<{ k: string }>(sql('fn_trace_contacts_cte'), [id, from, to])).rows.map((r) => r.k);
  const b = (await pool.query<{ k: string }>(sql('fn_trace_contacts'), [id, from, to])).rows.map((r) => r.k);
  if (a.join() === b.join()) cteOk++;
  else console.error(`CTE ≠ BFS for patient ${id}: ${a.length} vs ${b.length} rows`);
}
await pool.end();

const col = (k: number) => results.map((r) => r.d[k]!).filter((x) => !Number.isNaN(x));
const d1 = col(1);
const d2 = col(2);
const d3 = col(3);
const d5 = col(5);
const row = (name: string, xs: number[], gate: string, pass: boolean | null) =>
  `| ${name} | ${xs.length} | ${q(xs, 0.05)} | ${q(xs, 0.5)} | ${q(xs, 0.95)} | ${gate} | ${pass === null ? 'report' : pass ? 'PASS' : '**FAIL**'} |`;
const gates = {
  d1: q(d1, 0.5) >= 30 && q(d1, 0.5) <= 120 && q(d1, 0.05) >= 5,
  d2: q(d2, 0.5) >= 150 && q(d2, 0.5) <= 1000,
  d3: q(d3, 0.5) <= 0.5 * active,
  cte: cteOk === Math.min(cteSamples, indexes.length),
};

console.log(`[clinic_bench_x${scale}] window [${from.toISOString()}, ${to.toISOString()}), ${active} persons active in the window, ` +
  `${candidates.length} inpatients in the window → ${indexes.length} sampled`);
console.log('\n| reach within | n | p5 | p50 | p95 | gate | result |\n|---|---:|---:|---:|---:|---|---|');
console.log(row('1 hop (d1)', d1, 'p50 30–120, p5 ≥ 5', gates.d1));
console.log(row('2 hops (d2)', d2, 'p50 150–1000', gates.d2));
console.log(row('3 hops (d3)', d3, `p50 ≤ 50 % of active (${Math.floor(0.5 * active)})`, gates.d3));
console.log(row('5 hops (d5)', d5, `saturation p50 = ${((q(d5, 0.5) / active) * 100).toFixed(1)} % of active`, null));
console.log(`\nd3 p50 = ${((q(d3, 0.5) / active) * 100).toFixed(1)} % of window-active persons`);
console.log(`CTE = BFS at depth 2: ${cteOk}/${Math.min(cteSamples, indexes.length)} index patients`);
const ms3 = results.filter((r) => Number.isNaN(r.d[5]!)).map((r) => r.ms);
const ms5 = results.filter((r) => !Number.isNaN(r.d[5]!)).map((r) => r.ms);
if (ms5.length) console.log(`BFS depth 5: p50 ${q(ms5, 0.5)} ms, p95 ${q(ms5, 0.95)} ms (${values.workers} parallel workers)`);
if (ms3.length) console.log(`BFS depth 3: p50 ${q(ms3, 0.5)} ms, p95 ${q(ms3, 0.95)} ms`);
console.log(`total ${((Date.now() - t0) / 1000).toFixed(0)} s`);

const ok = Object.values(gates).every(Boolean);
console.log(ok ? '\nDENSITY GATE: PASS' : '\nDENSITY GATE: FAIL');
process.exitCode = ok ? 0 : 1;
