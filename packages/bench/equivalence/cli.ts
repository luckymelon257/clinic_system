import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ensureDatabase, migrate } from '@clinic/db';
import { admissionsByDeptMonth, createDriver, drugInteractions, exposurePath, fullEtl, graphCounts, neo4jConfigFromEnv, traceContacts, type PathResult } from '@clinic/graph';
import pg from 'pg';
import {
  assertSameDataset, loadGraphParams, pathHops, pgInteractions, pgPath, pgTrace,
  type InteractionKey, type PathPair, type Person, type PgPathRow, type TraceKey, type Window,
} from '../scenarios/graph/common';
import { chainProblems, diffSets, fmtDiff, interactionKey, traceKey, validateChainInPg, type PathChain } from './compare';

// Equivalence gate — no graph number is reported unless PostgreSQL and Neo4j give the same answers.
//   pnpm --filter @clinic/bench equivalence -- --scale golden   hand-computed fixture: PG CTE, PG BFS, Neo4j = expected.json
//   pnpm --filter @clinic/bench equivalence -- --scale x1       bench data: PG BFS = Neo4j (CTE where it finishes in 30 s)
// Loads the bench Neo4j (BENCH_NEO4J_URL / NEO4J_URL, default bolt://localhost:7688) with the dataset under test.

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    scale: { type: 'string', default: 'golden' },
    reload: { type: 'boolean', default: false },
    'cte-depth3': { type: 'string', default: '5' }, // CTE at depth 3 takes 5–30 s on ×1: a sample is enough
  },
});
const scale = values.scale!;
const TIMEOUT = 30_000;
const PG_BASE = 'postgres://clinic:clinic@localhost:5434';
const dbName = scale === 'golden' ? 'clinic_bench_golden' : `clinic_bench_${scale}`;
const pgUrl = `${PG_BASE}/${dbName}`;
const neoUrl = process.env.BENCH_NEO4J_URL || process.env.NEO4J_URL || 'bolt://localhost:7688';
const driver = createDriver({ ...neo4jConfigFromEnv(), url: neoUrl });

interface Check { group: string; name: string; status: 'pass' | 'fail' | 'skip'; detail?: string }
const checks: Check[] = [];
const record = (group: string, name: string, ok: boolean, detail?: string) => {
  checks.push({ group, name, status: ok ? 'pass' : 'fail', detail });
  if (!ok) console.error(`  ✗ ${group} · ${name}: ${detail}`);
};
const skip = (group: string, name: string, detail: string) => checks.push({ group, name, status: 'skip', detail });
const isTimeout = (e: unknown) => (e as { code?: string }).code === '57014';

const neoChain = (r: PathResult): PathChain => ({
  persons: r.steps.filter((s) => s.type === 'person').map((s) => ({ kind: s.kind as Person['kind'], id: s.id })),
  places: r.steps.filter((s) => s.type === 'place').map((s) => ({ kind: s.kind, id: s.id })),
});
const pgChain = (rows: readonly PgPathRow[]): PathChain => ({
  persons: rows.filter((r) => r.step_type === 'person').map((r) => ({ kind: r.kind as Person['kind'], id: r.id })),
  places: rows.filter((r) => r.step_type === 'place').map((r) => ({ kind: r.kind, id: r.id })),
});

const pool = new pg.Pool({ connectionString: pgUrl, max: 2, options: `-c statement_timeout=${TIMEOUT}` });
const t0 = Date.now();

async function compareTrace(group: string, name: string, p: Person, w: Window, depth: number, opts: { cte: boolean; expected?: TraceKey[] }) {
  const bfs = (await pgTrace(pool, 'bfs', p, w, depth)).map(traceKey);
  const neo = (await traceContacts(driver, { kind: p.kind, id: p.id, from: w.from, to: w.to, depth }, TIMEOUT)).map(traceKey);
  const d = diffSets(bfs, neo);
  record(group, `${name} pg-bfs = neo4j (${bfs.length})`, d.equal, fmtDiff(d));
  if (opts.expected) {
    const e = opts.expected.map(traceKey);
    const de = diffSets(neo, e);
    record(group, `${name} neo4j = expected`, de.equal, fmtDiff(de));
  }
  if (opts.cte) {
    try {
      const cte = (await pgTrace(pool, 'cte', p, w, depth)).map(traceKey);
      const dc = diffSets(cte, bfs);
      record(group, `${name} pg-cte = pg-bfs`, dc.equal, fmtDiff(dc));
    } catch (e) {
      if (!isTimeout(e)) throw e;
      skip(group, `${name} pg-cte`, `timeout ${TIMEOUT / 1000} s`);
    }
  }
}

async function comparePath(group: string, name: string, pp: PathPair, w: Window, expected?: number | null) {
  const pgRows = await pgPath(pool, pp, w);
  const pgLen = pathHops(pgRows);
  const neo = await exposurePath(driver, { aKind: pp.a.kind, aId: pp.a.id, bKind: pp.b.kind, bId: pp.b.id, from: w.from, to: w.to, maxDepth: pp.maxDepth }, TIMEOUT);
  const neoLen = neo ? neo.hops : null;
  record(group, `${name} length pg ${pgLen} = neo4j ${neoLen}`, pgLen === neoLen, `pg ${pgLen}, neo4j ${neoLen}`);
  if (expected !== undefined) record(group, `${name} length = expected ${expected}`, neoLen === expected, `neo4j ${neoLen}`);
  if (neo) {
    const c = neoChain(neo);
    const probs = [...chainProblems(c, pp.a, pp.b, neo.hops), ...(await validateChainInPg(pool, c, w))];
    record(group, `${name} neo4j path re-validated in PG`, probs.length === 0, probs.join('; '));
  }
  if (pgRows.length) {
    const c = pgChain(pgRows);
    const probs = [...chainProblems(c, pp.a, pp.b, pgLen!), ...(await validateChainInPg(pool, c, w))];
    record(group, `${name} pg path re-validated`, probs.length === 0, probs.join('; '));
  }
}

async function compareInteractions(group: string, name: string, ids: number[], patientId: number | null, at: string | null, expected?: InteractionKey[]) {
  const atIso = at ?? new Date().toISOString();
  const pgRows = (await pgInteractions(pool, ids, patientId, atIso)).map(interactionKey);
  const neoRows = (await drugInteractions(driver, { medicationIds: ids, patientId, at: atIso }, TIMEOUT)).map(interactionKey);
  const d = diffSets(pgRows, neoRows);
  record(group, `${name} pg = neo4j (${pgRows.length} rows)`, d.equal, fmtDiff(d));
  if (expected) {
    const de = diffSets(neoRows, expected.map(interactionKey));
    record(group, `${name} = expected`, de.equal, fmtDiff(de));
  }
}

async function compareCounts(group: string, expected?: { node: Record<string, number>; rel: Record<string, number> }) {
  const { rows } = await pool.query<{ kind: 'node' | 'rel'; label: string; count: string }>('SELECT kind, label, count FROM v_graph_counts');
  const neo = new Map((await graphCounts(driver)).map((r) => [`${r.kind}:${r.label}`, r.count]));
  for (const r of rows) {
    const n = neo.get(`${r.kind}:${r.label}`);
    record(group, `${r.label} v_graph_counts ${r.count} = neo4j ${n}`, Number(r.count) === n, `pg ${r.count}, neo4j ${n}`);
    if (expected) record(group, `${r.label} = expected`, expected[r.kind][r.label] === Number(r.count), `expected ${expected[r.kind][r.label]}`);
  }
}

async function compareDeptMonth(group: string, from: string, to: string) {
  const pgRows = (await pool.query<{ k: string }>(
    "SELECT department_id || ':' || to_char(month, 'YYYY-MM') || ':' || admissions AS k FROM fn_admissions_by_dept_month($1, $2)", [from, to])).rows.map((r) => r.k);
  // same instants as PG: dates are midnights in the hospital time zone (session TimeZone = Europe/Kyiv)
  const inst = (await pool.query<{ f: Date; t: Date }>('SELECT $1::date::timestamptz AS f, $2::date::timestamptz AS t', [from, to])).rows[0]!;
  const neoRows = (await admissionsByDeptMonth(driver, { from: inst.f, to: inst.t }, TIMEOUT)).map((r) => `${r.departmentId}:${r.month}:${r.admissions}`);
  const d = diffSets(pgRows, neoRows);
  record(group, `[${from}, ${to}) pg = neo4j (${pgRows.length} rows)`, d.equal, fmtDiff(d));
}

async function loadNeo4j() {
  try {
    if (values.reload) throw new Error('reload requested');
    await assertSameDataset(pool, driver);
    console.log(`Neo4j ${neoUrl} already holds ${dbName}`);
  } catch {
    console.log(`full ETL ${dbName} → ${neoUrl} …`);
    const r = await fullEtl(pgUrl, driver);
    console.log(`  ${(r.totalMs / 1000).toFixed(1)} s`);
  }
}

// ---------- golden ----------
async function golden() {
  const root = fileURLToPath(new URL('../../graph/fixtures/golden/', import.meta.url));
  const expected = JSON.parse(readFileSync(`${root}expected.json`, 'utf8')) as {
    counts: { node: Record<string, number>; rel: Record<string, number> };
    trace: { name: string; index: Person; from: string; to: string; depth: number; expected: TraceKey[] }[];
    path: { name: string; a: Person; b: Person; from: string; to: string; maxDepth: number; length: number | null }[];
    interactions: { name: string; medicationIds: number[]; patientId: number | null; at: string | null; expected: InteractionKey[] }[];
  };
  await ensureDatabase(pgUrl);
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public');
  await admin.end();
  await migrate(pgUrl);
  await pool.query(readFileSync(`${root}fixture.sql`, 'utf8'));
  const r = await fullEtl(pgUrl, driver);
  console.log(`golden fixture → ${dbName}, full ETL ${(r.totalMs / 1000).toFixed(1)} s`);

  await compareCounts('counts', expected.counts);
  for (const c of expected.trace) {
    const w = { from: c.from, to: c.to };
    await compareTrace('trace', c.name.split(' ')[0]!, c.index, w, c.depth, { cte: true, expected: c.expected });
    const cte = (await pgTrace(pool, 'cte', c.index, w, c.depth)).map(traceKey);
    const d = diffSets(cte, c.expected.map(traceKey));
    record('trace', `${c.name.split(' ')[0]} pg-cte = expected`, d.equal, fmtDiff(d));
  }
  for (const c of expected.path) {
    await comparePath('path', c.name.split(' ')[0]!, { a: c.a, b: c.b, dist: c.length, maxDepth: c.maxDepth }, { from: c.from, to: c.to }, c.length);
  }
  for (const c of expected.interactions) {
    await compareInteractions('interactions', c.name.split(' ')[0]!, c.medicationIds, c.patientId, c.at, c.expected);
  }
}

// ---------- bench scale ----------
async function bench() {
  const p = loadGraphParams(scale);
  await loadNeo4j();
  await compareCounts('counts');
  const cteDepth3 = Number(values['cte-depth3']);
  // 200 traces: index i at depth 1 + (i mod 5) → 40 per depth; CTE at depth ≤ 2 always, depth 3 on a sample
  let d3cte = 0;
  for (const [i, id] of p.trace.entries()) {
    const depth = 1 + (i % 5);
    const cte = depth <= 2 || (depth === 3 && d3cte++ < cteDepth3);
    await compareTrace(`trace d${depth}`, `patient ${id}`, { kind: 'patient', id }, p.windows.d14, depth, { cte });
    if ((i + 1) % 25 === 0) console.log(`  traces ${i + 1}/${p.trace.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  // S2 windows: depth 3 on the short-window persons, 20 per window
  for (const wk of ['d3', 'd14', 'd60'] as const) {
    for (const id of p.traceShort.slice(0, 20)) await compareTrace(`window ${wk}`, `patient ${id}`, { kind: 'patient', id }, p.windows[wk], 3, { cte: false });
  }
  for (const k of ['d2', 'd4', 'unreachable'] as const) {
    for (const pp of p.paths[k]) await comparePath(`path ${k}`, `${pp.a.id}→${pp.b.id}`, pp, p.windows.d14, pp.dist);
  }
  for (const k of ['m1', 'm5', 'm15'] as const) {
    for (const [i, ids] of p.meds[k].entries()) await compareInteractions(`interactions ${k}`, `set ${i}`, ids, null, p.windows.d14.from);
  }
  for (const pm of p.meds.patient) await compareInteractions('interactions patient', `patient ${pm.patientId}`, pm.medicationIds, pm.patientId, pm.at);
  for (const dm of p.deptMonth) await compareDeptMonth('dept-month', dm.from, dm.to);
}

try {
  await (scale === 'golden' ? golden() : bench());
} finally {
  await pool.end();
  await driver.close();
}

const groups = [...new Set(checks.map((c) => c.group))];
console.log(`\n## Equivalence ${scale} (${dbName} ↔ ${neoUrl})\n`);
console.log('| group | checks | pass | fail | skipped |\n|---|---:|---:|---:|---:|');
for (const g of groups) {
  const cs = checks.filter((c) => c.group === g);
  const n = (s: Check['status']) => cs.filter((c) => c.status === s).length;
  console.log(`| ${g} | ${cs.length} | ${n('pass')} | ${n('fail')} | ${n('skip')} |`);
}
const fails = checks.filter((c) => c.status === 'fail');
const skips = checks.filter((c) => c.status === 'skip');
console.log(`| **total** | ${checks.length} | ${checks.length - fails.length - skips.length} | ${fails.length} | ${skips.length} |`);
if (skips.length) console.log(`\nskipped: ${skips.map((s) => `${s.group} ${s.name} (${s.detail})`).join('; ')}`);
const out = fileURLToPath(new URL(`./result-${scale}.json`, import.meta.url));
writeFileSync(out, JSON.stringify({ scale, db: dbName, neo4j: neoUrl, finishedAt: new Date().toISOString(),
  seconds: Math.round((Date.now() - t0) / 1000), total: checks.length, failed: fails.length, skipped: skips.length,
  groups: groups.map((g) => ({ group: g, checks: checks.filter((c) => c.group === g).length, failed: checks.filter((c) => c.group === g && c.status === 'fail').length })),
  failures: fails.slice(0, 50), skips }, null, 1) + '\n');
console.log(`\n${fails.length ? `EQUIVALENCE: FAIL (${fails.length})` : 'EQUIVALENCE: PASS'} in ${((Date.now() - t0) / 1000).toFixed(0)} s → ${out}`);
process.exitCode = fails.length ? 1 : 0;
