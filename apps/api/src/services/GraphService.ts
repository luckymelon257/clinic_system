import type {
  ExposurePathQuery,
  ExposurePathResult,
  InteractionCheckInput,
  InteractionCheckResult,
  InteractionSeverity,
  StaffRole,
  TraceContactsQuery,
  TraceResult,
} from '@clinic/contracts';
import { currentMedications, drugInteractions, exposurePath, syncStatus, traceContacts } from '@clinic/graph';
import { reads } from '../db/UnitOfWork';
import { pool } from '../db/pool';
import { notFound } from '../errors';
import { GRAPH_TIMEOUT_MS, graphDriver, isGraphDown, onGraph } from '../nosql';

const RANK: Record<InteractionSeverity, number> = { minor: 1, moderate: 2, major: 3 };
const iso = (s: string) => new Date(s).toISOString();

/** Freshness of the graph read-model (BR-11): asOf = PG time up to which every change is in Neo4j. */
async function freshness() {
  const s = await syncStatus(pool);
  return { asOf: s.asOf, lagMs: Math.max(0, Math.round(s.lagMs)) };
}

async function indexPerson(kind: string, id: number) {
  const p = await reads.graph.person(kind, id);
  if (!p) throw notFound(kind === 'staff' ? 'Співробітника не знайдено' : 'Пацієнта не знайдено');
  return { kind: p.personKind, id: p.personId, name: p.name, role: p.role as StaffRole | null };
}

export const GraphService = {
  /** F-35: Neo4j BFS (D-44); PG is the source of truth for names and freshness. */
  async trace(q: TraceContactsQuery): Promise<TraceResult> {
    const index = await indexPerson(q.personKind, q.personId);
    const t0 = performance.now();
    const rows = await onGraph((d) => traceContacts(d, { kind: q.personKind, id: q.personId, from: q.from, to: q.to, depth: q.depth }, GRAPH_TIMEOUT_MS));
    const tookMs = Math.round((performance.now() - t0) * 10) / 10;
    return {
      index,
      from: iso(q.from),
      to: iso(q.to),
      depth: q.depth,
      contacts: rows.map((r) => ({
        kind: r.kind,
        id: r.id,
        name: r.name ?? '',
        role: (r.role as StaffRole | null) ?? null,
        hops: r.hops,
        parentKind: r.parentKind,
        parentId: r.parentId,
        exposure: r.exposure,
        placeId: r.placeId,
        placeName: r.placeName ?? null,
        overlapMinutes: Math.round(r.overlapMinutes * 10) / 10,
      })),
      tookMs,
      engine: 'neo4j',
      ...(await freshness()),
    };
  },

  /** F-36: shortest exposure chain or `found: false`. */
  async path(q: ExposurePathQuery): Promise<ExposurePathResult> {
    await indexPerson(q.aKind, q.aId);
    await indexPerson(q.bKind, q.bId);
    const r = await onGraph((d) =>
      exposurePath(d, { aKind: q.aKind, aId: q.aId, bKind: q.bKind, bId: q.bId, from: q.from, to: q.to, maxDepth: q.maxDepth }, GRAPH_TIMEOUT_MS));
    const steps: ExposurePathResult['steps'] = (r?.steps ?? []).map((s) =>
      s.type === 'person' ? { ...s, name: s.name ?? '' } : { ...s, from: iso(s.from), to: iso(s.to) });
    return { found: r !== null, hops: r?.hops ?? null, steps, engine: 'neo4j', ...(await freshness()) };
  },

  /**
   * F-37 / D-33: Neo4j (medication → class → interacts); when Neo4j is down the same question goes to
   * fn_drug_interactions in PG (D-28) — identical rows (golden gate), `engine` says which one answered.
   */
  async interactions(input: InteractionCheckInput): Promise<InteractionCheckResult> {
    const ids = [...new Set(input.medicationIds)];
    let engine: 'neo4j' | 'postgres' = 'neo4j';
    let rows: { a: number; b: number; severity: InteractionSeverity; via: 'direct' | 'class'; classA: number | null; classB: number | null }[];
    let current: number[];
    try {
      const d = graphDriver();
      rows = await drugInteractions(d, { medicationIds: ids, patientId: input.patientId, at: input.at }, GRAPH_TIMEOUT_MS);
      current = input.patientId ? await currentMedications(d, input.patientId, input.at ?? new Date()) : [];
    } catch (e) {
      if (!isGraphDown(e)) throw e;
      engine = 'postgres';
      rows = (await reads.graph.interactions(ids, input.patientId, input.at)).map((r) => ({
        a: r.medicationA, b: r.medicationB, severity: r.severity, via: r.via, classA: r.classA, classB: r.classB,
      }));
      current = input.patientId ? await reads.graph.activeMedications(input.patientId, input.at) : [];
    }
    const medIds = [...new Set(rows.flatMap((r) => [r.a, r.b]))];
    const classIds = [...new Set(rows.flatMap((r) => [r.classA, r.classB]).filter((x): x is number => x !== null))];
    const [meds, classes] = await Promise.all([reads.graph.medicationNames(medIds), reads.graph.classNames(classIds)]);
    const medName = new Map(meds.map((m) => [m.id, m.name]));
    const className = new Map(classes.map((c) => [c.id, c.name]));
    const interactions = rows.map((r) => ({
      medicationAId: r.a,
      medicationAName: medName.get(r.a) ?? `#${r.a}`,
      medicationBId: r.b,
      medicationBName: medName.get(r.b) ?? `#${r.b}`,
      severity: r.severity,
      via: r.via,
      classAId: r.classA,
      classAName: r.classA === null ? null : (className.get(r.classA) ?? `#${r.classA}`),
      classBId: r.classB,
      classBName: r.classB === null ? null : (className.get(r.classB) ?? `#${r.classB}`),
    }));
    const maxSeverity = interactions.reduce<InteractionSeverity | null>(
      (m, r) => (m === null || RANK[r.severity] > RANK[m] ? r.severity : m), null);
    const fresh = engine === 'neo4j' ? await freshness() : { asOf: new Date().toISOString(), lagMs: 0 };
    return { interactions, maxSeverity, requiresAcknowledgement: maxSeverity === 'major', currentMedicationIds: current, engine, ...fresh };
  },
};
