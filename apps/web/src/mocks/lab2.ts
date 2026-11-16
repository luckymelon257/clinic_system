import type {
  Bed,
  BedCounts,
  DrugInteraction,
  ExposurePathResult,
  ExposureType,
  Health,
  IcuAlert,
  IcuBed,
  InteractionCheckResult,
  InteractionSeverity,
  PathStep,
  PersonKind,
  StaffRole,
  TraceContact,
  TraceResult,
  TriageEntry,
  Vitals,
} from '@clinic/contracts';

/** The part of the mock DB this module reads (structural, so db.ts can import us without a type cycle). */
type Db = {
  patients: { id: number; lastName: string; firstName: string; middleName: string | null }[];
  medications: { id: number; name: string }[];
  beds: Bed[];
};

// In-memory stand-ins for the Lab 2 engines (Neo4j, Redis) so every Lab 2 page works in mock mode.
// The contact graph uses the same hop semantics as the real engines (packages/graph/fixtures/golden/README.md):
// presences in the same place whose intervals intersect each other and the window [from, to) — min hops per person.

const H = 3_600_000;
const D = 24 * H;
const iso = (ms: number) => new Date(ms).toISOString();

type Presence = { kind: PersonKind; id: number; place: ExposureType; placeId: number; f: number; t: number };
type Staff = { id: number; name: string; role: StaffRole };

const PLACE_NAMES: Record<ExposureType, Record<number, string>> = {
  room: { 1: 'Кімната 101', 2: 'Кімната 201', 3: 'Кімната 301' },
  ward: { 1: 'Палата 101', 3: 'Палата 201', 5: 'Палата 301' },
  office: { 1: 'Кабінет Іваненка О. П.', 2: 'Кабінет Коваленко Н. С.' },
};

function seedLab2(now: number) {
  const day0 = Math.floor(now / D) * D; // UTC midnight today
  const at = (days: number, hours = 0) => day0 + days * D + hours * H;
  const staff: Staff[] = [
    { id: 1, name: 'Іваненко Олег Петрович', role: 'doctor' },
    { id: 2, name: 'Коваленко Наталія Сергіївна', role: 'doctor' },
    { id: 5, name: 'Гнатюк Оксана (медсестра)', role: 'nurse' },
    { id: 6, name: 'Сорока Галина (медсестра)', role: 'nurse' },
  ];
  // patient stays (room + ward), nurse / doctor shifts (ward), appointments (office: patient + doctor)
  const stay = (id: number, roomId: number, wardId: number, from: number, to: number): Presence[] => [
    { kind: 'patient', id, place: 'room', placeId: roomId, f: from, t: to },
    { kind: 'patient', id, place: 'ward', placeId: wardId, f: from, t: to },
  ];
  const visit = (patientId: number, doctorId: number, f: number): Presence[] => [
    { kind: 'patient', id: patientId, place: 'office', placeId: doctorId, f, t: f + H / 2 },
    { kind: 'staff', id: doctorId, place: 'office', placeId: doctorId, f, t: f + H / 2 },
  ];
  const presence: Presence[] = [
    ...stay(7, 1, 1, at(-6), 9e15), // P7 open stay
    ...stay(1, 1, 1, at(-8), at(-4)),
    ...stay(2, 1, 1, at(-3), at(-1)),
    ...stay(3, 3, 5, at(-5), at(-2)),
    ...stay(5, 2, 3, at(-9), at(-7)),
    { kind: 'staff', id: 5, place: 'ward', placeId: 1, f: at(-5, 7), t: at(-5, 15) },
    { kind: 'staff', id: 5, place: 'ward', placeId: 5, f: at(-3, 7), t: at(-3, 15) },
    { kind: 'staff', id: 6, place: 'ward', placeId: 3, f: at(-8, 23), t: at(-7, 7) },
    { kind: 'staff', id: 1, place: 'ward', placeId: 1, f: at(-2, 8), t: at(-2, 16) },
    ...visit(4, 1, at(-10, 10)),
    ...visit(6, 2, at(-8, 11)),
    ...visit(8, 1, at(-1, 9)),
  ];
  return { staff, presence };
}

// ---------- graph ----------
function personName(db: Db, staff: Staff[], kind: PersonKind, id: number) {
  if (kind === 'staff') return staff.find((s) => s.id === id)?.name ?? `Співробітник #${id}`;
  const p = db.patients.find((x) => x.id === id);
  return p ? `${p.lastName} ${p.firstName} ${p.middleName ?? ''}`.trim() : `Пацієнт #${id}`;
}

const PLACE_RANK: Record<ExposureType, number> = { room: 0, office: 1, ward: 2 };
const key = (k: PersonKind, id: number) => `${k}:${id}`;

type Edge = { to: Presence; via: ExposureType; placeId: number; overlap: number };

function neighbours(all: Presence[], kind: PersonKind, id: number, from: number, to: number): Edge[] {
  const mine = all.filter((p) => p.kind === kind && p.id === id);
  const out: Edge[] = [];
  for (const x of mine)
    for (const y of all) {
      if (y.kind === kind && y.id === id) continue;
      if (y.place !== x.place || y.placeId !== x.placeId) continue;
      const lo = Math.max(x.f, y.f, from);
      const hi = Math.min(x.t, y.t, to);
      if (lo < hi) out.push({ to: y, via: x.place, placeId: x.placeId, overlap: (hi - lo) / 60_000 });
    }
  return out.sort((a, b) => PLACE_RANK[a.via] - PLACE_RANK[b.via] || a.to.id - b.to.id);
}

export function mockTrace(db: Db, s: Lab2State, q: { personKind: PersonKind; personId: number; from: string; to: string; depth: number }): TraceResult {
  const from = Date.parse(q.from);
  const to = Date.parse(q.to);
  const seen = new Map<string, TraceContact>();
  const start = key(q.personKind, q.personId);
  let frontier: [PersonKind, number][] = [[q.personKind, q.personId]];
  for (let hop = 1; hop <= q.depth && frontier.length; hop++) {
    const next: [PersonKind, number][] = [];
    for (const [k, id] of frontier)
      for (const e of neighbours(s.graph.presence, k, id, from, to)) {
        const kk = key(e.to.kind, e.to.id);
        if (kk === start || seen.has(kk)) continue;
        seen.set(kk, {
          kind: e.to.kind,
          id: e.to.id,
          name: personName(db, s.graph.staff, e.to.kind, e.to.id),
          role: e.to.kind === 'staff' ? (s.graph.staff.find((x) => x.id === e.to.id)?.role ?? null) : null,
          hops: hop,
          parentKind: k,
          parentId: id,
          exposure: e.via,
          placeId: e.placeId,
          placeName: PLACE_NAMES[e.via][e.placeId] ?? null,
          overlapMinutes: Math.round(e.overlap * 10) / 10,
        });
        next.push([e.to.kind, e.to.id]);
      }
    frontier = next;
  }
  const role = q.personKind === 'staff' ? (s.graph.staff.find((x) => x.id === q.personId)?.role ?? null) : null;
  return {
    index: { kind: q.personKind, id: q.personId, name: personName(db, s.graph.staff, q.personKind, q.personId), role },
    from: q.from,
    to: q.to,
    depth: q.depth,
    contacts: [...seen.values()],
    tookMs: 3.2,
    engine: 'neo4j',
    asOf: new Date().toISOString(),
    lagMs: 120,
  };
}

export function mockPath(
  db: Db,
  s: Lab2State,
  q: { aKind: PersonKind; aId: number; bKind: PersonKind; bId: number; from: string; to: string; maxDepth: number },
): ExposurePathResult {
  const from = Date.parse(q.from);
  const to = Date.parse(q.to);
  const prev = new Map<string, { k: PersonKind; id: number; e: Edge }>();
  const start = key(q.aKind, q.aId);
  const goal = key(q.bKind, q.bId);
  let frontier: [PersonKind, number][] = [[q.aKind, q.aId]];
  const visited = new Set([start]);
  for (let hop = 1; hop <= q.maxDepth && frontier.length && !visited.has(goal); hop++) {
    const next: [PersonKind, number][] = [];
    for (const [k, id] of frontier)
      for (const e of neighbours(s.graph.presence, k, id, from, to)) {
        const kk = key(e.to.kind, e.to.id);
        if (visited.has(kk)) continue;
        visited.add(kk);
        prev.set(kk, { k, id, e });
        next.push([e.to.kind, e.to.id]);
      }
    frontier = next;
  }
  const meta = { engine: 'neo4j' as const, asOf: new Date().toISOString(), lagMs: 120 };
  if (!visited.has(goal)) return { found: false, hops: null, steps: [], ...meta };
  const steps: PathStep[] = [];
  let cur = goal;
  let [ck, cid] = [q.bKind, q.bId] as [PersonKind, number];
  while (cur !== start) {
    const p = prev.get(cur)!;
    steps.unshift({ type: 'person', kind: ck, id: cid, name: personName(db, s.graph.staff, ck, cid) });
    const lo = Math.max(p.e.to.f, from);
    const hi = Math.min(p.e.to.t, to);
    steps.unshift({ type: 'place', kind: p.e.via, id: p.e.placeId, name: PLACE_NAMES[p.e.via][p.e.placeId] ?? null, from: iso(lo), to: iso(hi) });
    [ck, cid] = [p.k, p.id];
    cur = key(p.k, p.id);
  }
  steps.unshift({ type: 'person', kind: q.aKind, id: q.aId, name: personName(db, s.graph.staff, q.aKind, q.aId) });
  return { found: true, hops: steps.filter((x) => x.type === 'person').length - 1, steps, ...meta };
}

// ---------- drug interactions (F-37) ----------
// Mock catalogue ids (db.ts): 1 Парацетамол, 2 Ібупрофен, 4 Лізиноприл, 5 Метформін, 6 Омепразол, 8 Цефтріаксон,
// 11 Варфарин, 12 Аспірин. Patient 1 currently takes Варфарин → adding Ібупрофен is a `major` interaction.
const CLASSES: Record<number, { id: number; name: string }[]> = {
  2: [{ id: 2, name: 'НПЗЗ' }],
  4: [{ id: 3, name: 'Інгібітори АПФ' }],
  11: [{ id: 1, name: 'Антикоагулянти' }],
  12: [{ id: 2, name: 'НПЗЗ' }, { id: 4, name: 'Антиагреганти' }],
};
const CLASS_PAIRS: [number, number, InteractionSeverity][] = [
  [1, 2, 'major'],
  [1, 4, 'major'],
  [2, 2, 'moderate'],
  [2, 3, 'moderate'],
];
const MED_PAIRS: [number, number, InteractionSeverity][] = [
  [5, 8, 'minor'],
  [11, 12, 'major'],
];
const ACTIVE_MEDS: Record<number, number[]> = { 1: [11] };
const RANK: Record<InteractionSeverity, number> = { minor: 1, moderate: 2, major: 3 };

export function mockInteractions(db: Db, body: { medicationIds: number[]; patientId: number | null }): InteractionCheckResult {
  const current = body.patientId ? (ACTIVE_MEDS[body.patientId] ?? []) : [];
  const fresh = new Set(body.medicationIds);
  const all = [...new Set([...body.medicationIds, ...current])].sort((a, b) => a - b);
  const name = (id: number) => db.medications.find((m) => m.id === id)?.name ?? `Препарат #${id}`;
  const rows: DrugInteraction[] = [];
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!;
      const b = all[j]!;
      if (!fresh.has(a) && !fresh.has(b)) continue;
      const base = { medicationAId: a, medicationAName: name(a), medicationBId: b, medicationBName: name(b) };
      for (const [x, y, sev] of MED_PAIRS)
        if (x === a && y === b) rows.push({ ...base, severity: sev, via: 'direct', classAId: null, classAName: null, classBId: null, classBName: null });
      for (const ca of CLASSES[a] ?? [])
        for (const cb of CLASSES[b] ?? []) {
          const hit = CLASS_PAIRS.find(([x, y]) => (x === ca.id && y === cb.id) || (x === cb.id && y === ca.id));
          if (hit) rows.push({ ...base, severity: hit[2], via: 'class', classAId: ca.id, classAName: ca.name, classBId: cb.id, classBName: cb.name });
        }
    }
  const max = rows.reduce<InteractionSeverity | null>((m, r) => (!m || RANK[r.severity] > RANK[m] ? r.severity : m), null);
  return {
    interactions: rows,
    maxSeverity: max,
    requiresAcknowledgement: max === 'major',
    currentMedicationIds: current,
    engine: 'neo4j',
    asOf: new Date().toISOString(),
    lagMs: 0,
  };
}

// ---------- triage (ZSET semantics: score = esi·1e13 + arrivalMs, ZPOPMIN) ----------
type TriageRow = Omit<TriageEntry, 'position'>;
const score = (e: TriageRow) => e.esi * 1e13 + Date.parse(e.arrivedAt);

export function triageItems(s: Lab2State): TriageEntry[] {
  return [...s.triage].sort((a, b) => score(a) - score(b)).map((e, i) => ({ ...e, position: i + 1 }));
}

export function triageAdd(s: Lab2State, body: { patientId: number | null; patientName: string; esi: number; complaint: string }): TriageEntry {
  const row: TriageRow = { id: ++s.triageSeq, ...body, arrivedAt: new Date().toISOString() };
  s.triage.push(row);
  return triageItems(s).find((e) => e.id === row.id)!;
}

export function triageCallNext(s: Lab2State) {
  const [first] = triageItems(s);
  if (!first) return { entry: null, remaining: 0 };
  s.triage = s.triage.filter((e) => e.id !== first.id);
  return { entry: { ...first, position: 0 }, remaining: s.triage.length };
}

// ---------- beds / ICU / health ----------
export function mockBedCounts(db: Db): BedCounts {
  const wards = new Map<number, BedCounts['items'][number]>();
  for (const b of db.beds) {
    const w = wards.get(b.wardId) ?? {
      wardId: b.wardId,
      wardNumber: b.wardNumber,
      wardType: b.wardType,
      departmentId: b.departmentId,
      departmentName: b.departmentName,
      total: 0,
      free: 0,
      occupied: 0,
    };
    w.total++;
    if (b.status === 'available') w.free++;
    if (b.status === 'occupied') w.occupied++;
    wards.set(b.wardId, w);
  }
  return { items: [...wards.values()], source: 'redis', reconciledAt: new Date(Date.now() - 40_000).toISOString() };
}

export function vitalsAt(bedId: number, tick: number, critical = false): Vitals {
  const wobble = (base: number, amp: number) => Math.round((base + amp * Math.sin(tick / 3 + bedId)) * 10) / 10;
  return {
    hr: critical ? 148 : wobble(82, 6),
    spo2: critical ? 86 : wobble(96, 1.5),
    sbp: wobble(122, 8),
    dbp: wobble(78, 5),
    rr: wobble(16, 2),
    temp: wobble(36.9, 0.3),
    at: new Date(Date.now() - (5 - tick) * 1000).toISOString(),
  };
}

export function mockIcuBeds(db: Db, s: Lab2State): IcuBed[] {
  return db.beds
    .filter((b) => b.wardType === 'icu')
    .map((b) => ({
      bedId: b.id,
      bedNumber: b.bedNumber,
      wardId: b.wardId,
      wardNumber: b.wardNumber,
      patientId: b.patientId,
      patientName: b.patientName,
      vitals: b.patientId ? vitalsAt(b.id, 5) : null,
      alerting: s.alerts.some((a) => a.bedId === b.id && Date.now() - Date.parse(a.at) < 5 * 60_000),
    }));
}

export function makeAlert(db: Db, bedId: number, vitals: Vitals, id: string): IcuAlert {
  const bed = db.beds.find((b) => b.id === bedId);
  const violations: IcuAlert['violations'] = [];
  if (vitals.hr > 140) violations.push({ sign: 'hr', value: vitals.hr, rule: '> 140' });
  if (vitals.hr < 40) violations.push({ sign: 'hr', value: vitals.hr, rule: '< 40' });
  if (vitals.spo2 < 88) violations.push({ sign: 'spo2', value: vitals.spo2, rule: '< 88' });
  return { id, bedId, patientId: bed?.patientId ?? null, patientName: bed?.patientName ?? null, violations, vitals, at: vitals.at };
}

export function mockHealth(): Health {
  const up = (latencyMs: number) => ({ status: 'up' as const, latencyMs, error: null });
  return {
    status: 'up',
    postgres: up(1.2),
    neo4j: up(2.4),
    redis: up(0.3),
    graphSync: { pending: 0, lagMs: 0, lastProcessedAt: new Date().toISOString() },
    checkedAt: new Date().toISOString(),
  };
}

// ---------- state ----------
export function seedLab2State(db: Db) {
  const now = Date.now();
  const icuBed = db.beds.find((b) => b.wardType === 'icu' && b.patientId) ?? db.beds.find((b) => b.wardType === 'icu');
  const s = {
    graph: seedLab2(now),
    triage: [
      { id: 1, patientId: 3, patientName: 'Бойко Андрій Степанович', esi: 3, complaint: 'Біль у животі', arrivedAt: iso(now - 35 * 60_000) },
      { id: 2, patientId: null, patientName: 'Невідомий чоловік', esi: 2, complaint: 'Задишка, біль у грудях', arrivedAt: iso(now - 12 * 60_000) },
      { id: 3, patientId: 6, patientName: 'Олійник Софія Андріївна', esi: 4, complaint: 'Порізана рука', arrivedAt: iso(now - 50 * 60_000) },
    ] as TriageRow[],
    triageSeq: 3,
    alerts: [] as IcuAlert[],
  };
  if (icuBed) s.alerts.push(makeAlert(db, icuBed.id, { ...vitalsAt(icuBed.id, 0, true), at: iso(now - 20 * 60_000) }, `${now - 20 * 60_000}-0`));
  return s;
}
export type Lab2State = ReturnType<typeof seedLab2State>;
