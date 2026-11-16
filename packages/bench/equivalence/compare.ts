import type pg from 'pg';
import type { InteractionKey, Person, TraceKey, Window } from '../scenarios/graph/common';

// Pure comparison helpers of the equivalence gate (unit-tested in tests/graph-compare.test.ts) + the SQL re-validation
// of a path returned by Neo4j: every person → place → person step must be a real contact in the window.

export const traceKey = (t: TraceKey) => `${t.kind}:${t.id}:${t.hops}`;
export const interactionKey = (r: InteractionKey) => `${r.a}-${r.b}:${r.severity}:${r.via}:${r.classA ?? '-'}:${r.classB ?? '-'}`;

export interface SetDiff { equal: boolean; onlyLeft: string[]; onlyRight: string[] }

export function diffSets(left: readonly string[], right: readonly string[]): SetDiff {
  const l = new Set(left);
  const r = new Set(right);
  const onlyLeft = [...l].filter((x) => !r.has(x)).sort();
  const onlyRight = [...r].filter((x) => !l.has(x)).sort();
  return { equal: onlyLeft.length === 0 && onlyRight.length === 0 && l.size === left.length && r.size === right.length, onlyLeft, onlyRight };
}

export const fmtDiff = (d: SetDiff, max = 5) =>
  `only left [${d.onlyLeft.slice(0, max).join(', ')}${d.onlyLeft.length > max ? ', …' : ''}] ` +
  `only right [${d.onlyRight.slice(0, max).join(', ')}${d.onlyRight.length > max ? ', …' : ''}]`;

/** Person / place sequence of a path, engine-independent. */
export interface PathChain { persons: Person[]; places: { kind: string; id: number }[] }

/** Structural checks: alternates person, place, person …; starts at a, ends at b; hops = places. */
export function chainProblems(c: PathChain, a: Person, b: Person, hops: number): string[] {
  const out: string[] = [];
  if (c.persons.length !== c.places.length + 1) out.push(`persons ${c.persons.length} vs places ${c.places.length}`);
  if (c.places.length !== hops) out.push(`hops ${hops} but ${c.places.length} places`);
  const first = c.persons[0];
  const last = c.persons[c.persons.length - 1];
  if (!first || first.kind !== a.kind || first.id !== a.id) out.push('does not start at a');
  if (!last || last.kind !== b.kind || last.id !== b.id) out.push('does not end at b');
  const seen = new Set(c.persons.map((p) => `${p.kind}:${p.id}`));
  if (seen.size !== c.persons.length) out.push('a person repeats (not a shortest path)');
  return out;
}

const STEP_SQL = `
SELECT EXISTS (
  SELECT 1 FROM v_presence x
  JOIN v_presence y ON y.place_kind = x.place_kind AND y.place_id = x.place_id AND y.period && x.period
  WHERE x.person_kind = $1 AND x.person_id = $2 AND y.person_kind = $3 AND y.person_id = $4
    AND x.place_kind = $5 AND x.place_id = $6
    AND x.period && tstzrange($7, $8) AND y.period && tstzrange($7, $8)) AS ok`;

/** Re-validates every step of a path in PostgreSQL (independent of the engine that produced it). */
export async function validateChainInPg(pool: pg.Pool, c: PathChain, w: Window): Promise<string[]> {
  const bad: string[] = [];
  for (let i = 0; i < c.places.length; i++) {
    const x = c.persons[i]!;
    const y = c.persons[i + 1]!;
    const pl = c.places[i]!;
    const { rows } = await pool.query<{ ok: boolean }>(STEP_SQL, [x.kind, x.id, y.kind, y.id, pl.kind, pl.id, w.from, w.to]);
    if (!rows[0]!.ok) bad.push(`step ${i + 1}: ${x.kind}:${x.id} –${pl.kind}:${pl.id}→ ${y.kind}:${y.id} is not a contact in the window`);
  }
  return bad;
}
