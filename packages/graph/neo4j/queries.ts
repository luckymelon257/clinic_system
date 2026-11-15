import type { Driver } from 'neo4j-driver';
import { int, ints, readRows } from './driver';

// Read queries of the graph read-model. Semantics = packages/graph/fixtures/golden/README.md:
//  - presence counts in window [from, to) if f < to AND t > from (epoch ms, open stay t = 9e15);
//  - one hop = person -PRESENT-> place <-PRESENT- other person, both presences in the window and overlapping
//    (x.f < y.t AND y.f < x.t); touching intervals are not a contact;
//  - trace = minimal number of hops per reachable person, not time-ordered (D-25).
// All values travel as $parameters. The only literals spliced into query text are validated small integers
// (BFS depth) and labels from a fixed map — one cached plan per variant.

export type PersonKind = 'patient' | 'staff';
export type PlaceKind = 'room' | 'ward' | 'office';

const LABEL: Record<PersonKind, string> = { patient: 'Patient', staff: 'Staff' };

function bound(n: number, max: number, what: string): number {
  if (!Number.isInteger(n) || n < 1 || n > max) throw new RangeError(`${what} must be an integer 1..${max}, got ${n}`);
  return n;
}

const ms = (v: string | Date) => (v instanceof Date ? v.getTime() : Date.parse(v));

// One BFS level, written once and unrolled `depth` times (depth is a validated literal 1..8).
// Why not QPP + ANY SHORTEST: Cypher 5 paths never repeat a relationship, but a hop chain may legitimately pass
// through the SAME presence twice (P3 is reached via its W1 stay and passes it on to S1 via that same stay), so
// the shortest-path form misses such persons; REPEATABLE ELEMENTS exists only in Cypher 25 (Neo4j 2025.x), D-40.
// Per level: the frontier's presences that intersect the window are grouped by place, each place is expanded
// once, and a newcomer y is kept if one of its presences there overlaps any frontier presence (x.f < y.t AND
// y.f < x.t). `seen` holds every person already reached, so each person gets its minimal hop count.
function level(k: number, stopAtB: boolean): string {
  return `
CALL (seen, frontier) {
  UNWIND frontier AS x
  MATCH (x)-[r1:PRESENT]->(pl:Place)
  WHERE r1.f < $to AND r1.t > $from
  WITH pl, collect(r1) AS ins
  MATCH (pl)<-[r2:PRESENT]-(y:Person)
  WHERE r2.f < $to AND r2.t > $from AND NOT y IN seen
  WITH y, pl, r2, [r IN ins WHERE r.f < r2.t AND r2.f < r.t] AS hits
  WHERE size(hits) > 0
  WITH y, pl, r2, hits ORDER BY CASE WHEN pl:Room THEN 0 WHEN pl:Office THEN 1 ELSE 2 END
  WITH y, head(collect({pl: pl, r1: hits[0], r2: r2})) AS w // witness: the strongest exposure (room > office > ward)
  RETURN collect(y) AS next, collect({y: y, x: startNode(w.r1), pl: w.pl, r1: w.r1, r2: w.r2, hops: ${k}}) AS edges
}
WITH ${stopAtB ? 'b, ' : ''}seen + next AS seen, ${stopAtB ? 'CASE WHEN b IN next THEN [] ELSE next END' : 'next'} AS frontier, found + edges AS found`;
}

const witness = (carry = '') => `
UNWIND found AS e
WITH ${carry}e.y AS y, e.x AS x, e.pl AS pl, e.r1 AS r1, e.r2 AS r2, e.hops AS hops
RETURN ${carry}CASE WHEN y:Patient THEN 'patient' ELSE 'staff' END AS kind, y.id AS id, y.name AS name, y.role AS role, hops,
       CASE WHEN x:Patient THEN 'patient' ELSE 'staff' END AS parentKind, x.id AS parentId,
       CASE WHEN pl:Room THEN 'room' WHEN pl:Ward THEN 'ward' ELSE 'office' END AS exposure, pl.id AS placeId,
       pl.name AS placeName, r1.f AS f1, r1.t AS t1, r2.f AS f2, r2.t AS t2`;

export interface TraceParams {
  kind: PersonKind;
  id: number;
  from: string | Date;
  to: string | Date;
  depth: number; // 1..5 (BR-12)
}

export interface TraceRow {
  kind: PersonKind;
  id: number;
  name: string;
  role: string | null;
  hops: number;
  parentKind: PersonKind;
  parentId: number;
  exposure: PlaceKind;
  placeId: number;
  placeName: string | null;
  overlapMinutes: number; // overlap of the witness contact, clipped to the window
}

interface WitnessRow extends Omit<TraceRow, 'overlapMinutes'> {
  f1: number;
  t1: number;
  f2: number;
  t2: number;
}

/** Contact tracing (F-35): every person within `depth` hops with the minimal hop count and one witness edge. */
export function traceQuery(kind: PersonKind, depth: number): string {
  const levels = Array.from({ length: bound(depth, 5, 'depth') }, (_, i) => level(i + 1, false)).join('');
  return `
MATCH (a:${LABEL[kind]} {id: $id})
WITH [a] AS seen, [a] AS frontier, [] AS found${levels}${witness()}`;
}

const overlapMin = (r: WitnessRow, from: number, to: number) =>
  Math.max(0, Math.min(r.t1, r.t2, to) - Math.max(r.f1, r.f2, from)) / 60_000;

export async function traceContacts(driver: Driver, p: TraceParams, timeoutMs?: number): Promise<TraceRow[]> {
  const from = ms(p.from);
  const to = ms(p.to);
  const rows = await readRows<WitnessRow>(driver, traceQuery(p.kind, p.depth), { id: int(p.id), from: int(from), to: int(to) }, timeoutMs);
  return rows.map((r) => {
    const { f1: _f1, t1: _t1, f2: _f2, t2: _t2, ...rest } = r;
    return { ...rest, overlapMinutes: overlapMin(r, from, to) };
  });
}

export interface PathParams {
  aKind: PersonKind;
  aId: number;
  bKind: PersonKind;
  bId: number;
  from: string | Date;
  to: string | Date;
  maxDepth: number; // 1..8
}

export type PathStep =
  | { type: 'person'; kind: PersonKind; id: number; name: string }
  | { type: 'place'; kind: PlaceKind; id: number; name: string | null; from: string; to: string };

export interface PathResult {
  hops: number;
  steps: PathStep[]; // person, place, person, …, from a to b
}

/** Same BFS from a, stopping once b is reached; the witness edges give the chain back to a. */
export function pathQuery(aKind: PersonKind, bKind: PersonKind, maxDepth: number): string {
  const levels = Array.from({ length: bound(maxDepth, 8, 'maxDepth') }, (_, i) => level(i + 1, true)).join('');
  return `
MATCH (a:${LABEL[aKind]} {id: $aId}), (b:${LABEL[bKind]} {id: $bId})
WITH a, b, [a] AS seen, [a] AS frontier, [] AS found${levels.replaceAll('WITH b, ', 'WITH a, b, ')}
WHERE b IN seen
WITH a.name AS aName, found${witness('aName, ')}`;
}

export async function exposurePath(driver: Driver, p: PathParams, timeoutMs?: number): Promise<PathResult | null> {
  if (p.aKind === p.bKind && p.aId === p.bId) throw new RangeError('a and b must be different persons');
  const from = ms(p.from);
  const to = ms(p.to);
  const rows = await readRows<WitnessRow & { aName: string }>(driver, pathQuery(p.aKind, p.bKind, p.maxDepth),
    { aId: int(p.aId), bId: int(p.bId), from: int(from), to: int(to) }, timeoutMs);
  const byPerson = new Map(rows.map((r) => [`${r.kind}:${r.id}`, r]));
  let cur = byPerson.get(`${p.bKind}:${p.bId}`);
  if (!cur) return null;
  const hops = cur.hops;
  const rev: PathStep[] = [];
  while (cur) {
    const r: WitnessRow & { aName: string } = cur;
    rev.push({ type: 'person', kind: r.kind, id: r.id, name: r.name });
    rev.push({
      type: 'place', kind: r.exposure, id: r.placeId, name: r.placeName,
      from: new Date(Math.max(r.f1, r.f2, from)).toISOString(), to: new Date(Math.min(r.t1, r.t2, to)).toISOString(),
    });
    cur = byPerson.get(`${r.parentKind}:${r.parentId}`);
    if (!cur) rev.push({ type: 'person', kind: r.parentKind, id: r.parentId, name: r.aName }); // reached a
  }
  return { hops, steps: rev.reverse() };
}

export interface InteractionParams {
  medicationIds: number[];
  patientId?: number | null;
  at?: string | Date | null; // default now
}

export interface InteractionRow {
  a: number;
  b: number;
  severity: 'minor' | 'moderate' | 'major';
  via: 'direct' | 'class';
  classA: number | null;
  classB: number | null;
}

/**
 * D-33: medication set = new ∪ what the patient TAKES at `at`; a pair (a < b) is checked when at least one side is
 * new; one row per source — the direct pair and every class pair (class of a, class of b) that interacts.
 * INTERACTS is stored once per pair and matched undirected; a class–class self-loop = therapy duplication.
 */
export const INTERACTIONS_QUERY = `
OPTIONAL MATCH (:Patient {id: $patientId})-[t:TAKES]->(cur:Medication)
WHERE t.f <= $at AND $at < t.t
WITH collect(DISTINCT cur.id) AS current
WITH current, [x IN $ids WHERE NOT x IN current] + current AS allIds
UNWIND allIds AS a
UNWIND allIds AS b
WITH a, b WHERE a < b AND (a IN $ids OR b IN $ids)
MATCH (ma:Medication {id: a}), (mb:Medication {id: b})
CALL (ma, mb) {
  MATCH (ma)-[i:INTERACTS]-(mb)
  RETURN DISTINCT i.severity AS severity, 'direct' AS via, null AS classA, null AS classB
  UNION
  MATCH (ma)-[:IN_CLASS]->(ca:DrugClass)-[i:INTERACTS]-(cb:DrugClass)<-[:IN_CLASS]-(mb)
  RETURN DISTINCT i.severity AS severity, 'class' AS via, ca.id AS classA, cb.id AS classB
}
RETURN ma.id AS a, mb.id AS b, severity, via, classA, classB
ORDER BY a, b, via DESC, classA, classB`;

export async function drugInteractions(driver: Driver, p: InteractionParams, timeoutMs?: number): Promise<InteractionRow[]> {
  const ids = [...new Set(p.medicationIds)];
  return readRows<InteractionRow>(driver, INTERACTIONS_QUERY,
    { ids: ints(ids), patientId: int(p.patientId ?? -1), at: int(p.at ? ms(p.at) : Date.now()) }, timeoutMs);
}

/** Medications the patient takes at `at` (API response field `currentMedicationIds`). */
export async function currentMedications(driver: Driver, patientId: number, at: string | Date = new Date()): Promise<number[]> {
  const rows = await readRows<{ id: number }>(driver,
    'MATCH (:Patient {id: $patientId})-[t:TAKES]->(m:Medication) WHERE t.f <= $at AND $at < t.t RETURN DISTINCT m.id AS id ORDER BY id',
    { patientId: int(patientId), at: int(ms(at)) });
  return rows.map((r) => r.id);
}

export interface DeptMonthRow {
  departmentId: number;
  month: string; // 'YYYY-MM' in Europe/Kyiv (hospital time zone, as date_trunc in PG)
  admissions: number;
}

/**
 * Flat aggregate (benchmark S5, expected to lose to PG): admissions per department per month by admission start in
 * [from, to). Each admission has exactly one PRESENT edge to a :Ward (src = 'admission').
 */
export const DEPT_MONTH_QUERY = `
MATCH (:Patient)-[r:PRESENT {src: 'admission'}]->(w:Ward)
WHERE r.f >= $from AND r.f < $to
WITH w.departmentId AS departmentId, datetime({epochMillis: r.f, timezone: 'Europe/Kyiv'}) AS d
RETURN departmentId, toString(d.year) + '-' + right('0' + toString(d.month), 2) AS month, count(*) AS admissions
ORDER BY departmentId, month`;

export async function admissionsByDeptMonth(driver: Driver, p: { from: string | Date; to: string | Date }, timeoutMs?: number): Promise<DeptMonthRow[]> {
  return readRows<DeptMonthRow>(driver, DEPT_MONTH_QUERY, { from: int(ms(p.from)), to: int(ms(p.to)) }, timeoutMs);
}

export interface CountRow {
  kind: 'node' | 'rel';
  label: string;
  count: number;
}

const NODE_LABELS = ['Patient', 'Staff', 'Room', 'Ward', 'Office', 'Medication', 'DrugClass'] as const;
const REL_TYPES = ['PRESENT', 'IN', 'IN_CLASS', 'INTERACTS', 'TAKES'] as const;

/** Same shape and order as v_graph_counts; label / type counts come from the count store. */
export async function graphCounts(driver: Driver): Promise<CountRow[]> {
  const out: CountRow[] = [];
  for (const l of NODE_LABELS) {
    const [r] = await readRows<{ c: number }>(driver, `MATCH (n:${l}) RETURN count(n) AS c`);
    out.push({ kind: 'node', label: l, count: r!.c });
  }
  for (const t of REL_TYPES) {
    const [r] = await readRows<{ c: number }>(driver, `MATCH ()-[r:${t}]->() RETURN count(r) AS c`);
    out.push({ kind: 'rel', label: t, count: r!.c });
  }
  return out;
}
