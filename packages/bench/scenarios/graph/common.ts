import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { graphCounts } from '@clinic/graph';
import type { Driver } from 'neo4j-driver';
import type pg from 'pg';
import type { BenchContext } from '../../src/types';

// Shared by S1–S8, the params generator and the equivalence gate: params types, the PG / Neo4j call wrappers
// used by BOTH the benchmark and the equivalence check (the gate checks exactly what is measured), preflight.

export type Kind = 'patient' | 'staff';
export interface Person { kind: Kind; id: number }
export interface Window { from: string; to: string }
export interface PathPair { a: Person; b: Person; dist: number | null; maxDepth: number }
export interface PatientMeds { patientId: number; at: string; medicationIds: number[] }

export interface GraphParams {
  scale: string;
  db: string;
  seed: number;
  method: Record<string, string>; // how every list was chosen (shown in the report)
  windows: { d3: Window; d14: Window; d60: Window };
  trace: number[]; // index inpatients active in windows.d14 (S1, S8, equivalence)
  traceShort: number[]; // index inpatients active in windows.d3 ⊂ d14 ⊂ d60 (S2: same persons for all three windows)
  paths: { d2: PathPair[]; d4: PathPair[]; unreachable: PathPair[] };
  meds: { m1: number[][]; m5: number[][]; m15: number[][]; patient: PatientMeds[] };
  deptMonth: { from: string; to: string }[]; // 'YYYY-MM-DD', [from, to)
}

export const paramsPath = (scale: string) => fileURLToPath(new URL(`../../params/${scale}.json`, import.meta.url));
export const loadGraphParams = (scale: string): GraphParams => JSON.parse(readFileSync(paramsPath(scale), 'utf8')) as GraphParams;

/** Params from the harness (--params) or, if none was given, the committed file of the current scale. */
export function graphParams(ctx: BenchContext): GraphParams {
  const p = ctx.params as Partial<GraphParams>;
  return p && p.trace ? (p as GraphParams) : loadGraphParams(ctx.scale);
}

export const pick = <T>(xs: readonly T[], i: number): T => xs[i % xs.length]!;

// ---------- PostgreSQL ----------
export const SQL = {
  traceCte: 'SELECT person_kind, person_id, hops FROM fn_trace_contacts_cte($1, $2, $3, $4, $5)',
  traceBfs: 'SELECT person_kind, person_id, hops FROM fn_trace_contacts($1, $2, $3, $4, $5)',
  path: 'SELECT step, step_type, kind, id, f, t FROM fn_exposure_path($1, $2, $3, $4, $5, $6, $7)',
  interactions: 'SELECT medication_a, medication_b, severity, via, class_a, class_b FROM fn_drug_interactions($1, $2, $3)',
  deptMonth: 'SELECT department_id, month, admissions FROM fn_admissions_by_dept_month($1, $2)',
};

export interface TraceKey { kind: Kind; id: number; hops: number }

export async function pgTrace(pool: pg.Pool | pg.PoolClient, fn: 'cte' | 'bfs', p: Person, w: Window, depth: number): Promise<TraceKey[]> {
  const { rows } = await pool.query<{ person_kind: Kind; person_id: number; hops: number }>(fn === 'cte' ? SQL.traceCte : SQL.traceBfs,
    [p.kind, p.id, w.from, w.to, depth]);
  return rows.map((r) => ({ kind: r.person_kind, id: r.person_id, hops: r.hops }));
}

export interface PgPathRow { step: number; step_type: 'person' | 'place'; kind: string; id: number; f: Date | null; t: Date | null }

export async function pgPath(pool: pg.Pool | pg.PoolClient, pp: PathPair, w: Window): Promise<PgPathRow[]> {
  const { rows } = await pool.query<PgPathRow>(SQL.path, [pp.a.kind, pp.a.id, pp.b.kind, pp.b.id, w.from, w.to, pp.maxDepth]);
  return rows;
}

export const pathHops = (rows: readonly PgPathRow[]) => (rows.length ? rows.filter((r) => r.step_type === 'person').length - 1 : null);

export interface InteractionKey { a: number; b: number; severity: string; via: string; classA: number | null; classB: number | null }

export async function pgInteractions(pool: pg.Pool | pg.PoolClient, ids: number[], patientId: number | null, at: string | null): Promise<InteractionKey[]> {
  const { rows } = await pool.query<{ medication_a: number; medication_b: number; severity: string; via: string; class_a: number | null; class_b: number | null }>(
    SQL.interactions, [ids, patientId, at ?? new Date().toISOString()]);
  return rows.map((r) => ({ a: r.medication_a, b: r.medication_b, severity: r.severity, via: r.via, classA: r.class_a, classB: r.class_b }));
}

// ---------- plans ----------
/** EXPLAIN (ANALYZE, BUFFERS) of the measured statement. PL/pgSQL internals are not expanded by EXPLAIN — the BFS
 *  functions' own plans are in packages/graph/gen/PLANS.md (auto_explain); this records the outer call cost. */
export async function explainPg(pool: pg.Pool, sql: string, params: unknown[]): Promise<string> {
  const { rows } = await pool.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

interface ProfileNode { operatorType: string; rows: number; dbHits: number; children: ProfileNode[]; identifiers?: string[] }

/** PROFILE summary of a Cypher query: total db hits, and rows / db hits per operator (tree, indented). */
export async function profileCypher(driver: Driver, query: string, params: Record<string, unknown>): Promise<string> {
  const session = driver.session({ defaultAccessMode: 'READ' });
  try {
    const res = await session.run(`PROFILE ${query}`, params);
    const prof = res.summary.profile as unknown as ProfileNode | false;
    if (!prof) return 'no profile';
    const lines: string[] = [];
    let total = 0;
    const walk = (n: ProfileNode, depth: number) => {
      total += Number(n.dbHits);
      lines.push(`${'  '.repeat(depth)}${n.operatorType}  rows=${Number(n.rows)}  dbHits=${Number(n.dbHits)}`);
      for (const c of n.children) walk(c, depth + 1);
    };
    walk(prof, 0);
    return [`total dbHits=${total}, records=${res.records.length}`, ...lines].join('\n');
  } finally {
    await session.close();
  }
}

// ---------- preflight ----------
/** The graph in Neo4j must be the same dataset as the PG database the harness points at (counts = v_graph_counts). */
export async function assertSameDataset(pool: pg.Pool, driver: Driver): Promise<void> {
  const { rows } = await pool.query<{ kind: string; label: string; count: string }>('SELECT kind, label, count FROM v_graph_counts');
  const neo = new Map((await graphCounts(driver)).map((r) => [`${r.kind}:${r.label}`, r.count]));
  const bad = rows.filter((r) => neo.get(`${r.kind}:${r.label}`) !== Number(r.count))
    .map((r) => `${r.label}: pg ${r.count} ≠ neo4j ${neo.get(`${r.kind}:${r.label}`) ?? 0}`);
  if (bad.length) {
    const db = (await pool.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
    throw new Error(`Neo4j does not hold ${db} (${bad.slice(0, 3).join('; ')}) — run: pnpm --filter @clinic/bench prepare-graph -- --db ${db}`);
  }
}

const checked = new WeakSet<object>();
export async function preflight(ctx: BenchContext): Promise<void> {
  if (checked.has(ctx.engines)) return;
  await assertSameDataset(ctx.engines.pg, ctx.engines.neo4j);
  checked.add(ctx.engines);
}

// ---------- deterministic choice (same PRNG as the data generator: mulberry32, FNV-1a stream per section) ----------
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function stream(seed: number, section: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < section.length; i++) h = Math.imul(h ^ section.charCodeAt(i), 0x01000193);
  return mulberry32((seed ^ h) >>> 0);
}

export function shuffle<T>(r: () => number, xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
