import type { AddressInfo } from 'node:net';
import { routes, type IcuStreamEvent } from '@clinic/contracts';
import { createDriver, drainOnce } from '@clinic/graph';
import { ingestVitals, ping, type RedisCtx } from '@clinic/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { redisCtx, resetNoSql } from '../src/nosql';
import { app, day, demoDoctorId, fails, freeSlot, hit, newPatient, ok, password, DEMO } from './helpers';
import { TEST_NEO4J } from './url';

// Lab 2 routes on the real engines: clinic_api_test (PG), neo4j-test (bolt 7689, full ETL in global setup),
// Redis DB 4 with a random prefix per file.

const neo = createDriver(TEST_NEO4J);
afterAll(() => neo.close());

/** Applies every pending outbox event to Neo4j (what `pnpm graph:sync --follow` does in production). */
async function drainOutbox() {
  for (let i = 0; i < 200; i++) if ((await drainOnce(pool, neo, 'api-test', 2000)).claimed === 0) return;
}

async function redisReady(): Promise<RedisCtx> {
  const ctx = await redisCtx();
  for (let i = 0; i < 50 && (await ping(ctx)).status !== 'up'; i++) await new Promise((r) => setTimeout(r, 100));
  return ctx;
}

/** Runs fn with some engine env vars changed (e.g. pointed at a closed port), then restores them. */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  await resetNoSql();
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
    await resetNoSql();
    await redisReady();
  }
}
const REDIS_DOWN = { REDIS_URL: 'redis://localhost:6399/0' };
const NEO4J_DOWN = { NEO4J_URL: 'bolt://localhost:7999' };

async function freshToken(role: keyof typeof DEMO = 'registrar') {
  const res = await request(app).post(routes.login.path).send({ email: DEMO[role], password: password(role) });
  return routes.login.output.parse(res.body).token;
}

/** Truth for the counters: free / occupied per ward from v_beds. */
async function pgCounts() {
  const { rows } = await pool.query<{ ward_id: number; free: number; occupied: number }>(`
    SELECT ward_id, (count(*) FILTER (WHERE status = 'available'))::int AS free, (count(*) FILTER (WHERE status = 'occupied'))::int AS occupied
    FROM v_beds GROUP BY ward_id ORDER BY ward_id`);
  return Object.fromEntries(rows.map((r) => [r.ward_id, { free: r.free, occupied: r.occupied }]));
}
async function apiCounts() {
  const r = await ok('bedCounts', { as: 'registrar' });
  expect(r.source).toBe('redis');
  return Object.fromEntries(r.items.map((i) => [i.wardId, { free: i.free, occupied: i.occupied }]));
}

const medId = async (name: string) => (await pool.query<{ id: number }>('SELECT id FROM v_medications WHERE name = $1', [name])).rows[0]!.id;
const rowKey = (r: { medicationAId: number; medicationBId: number; severity: string; via: string; classAId: number | null; classBId: number | null }) =>
  `${r.medicationAId}-${r.medicationBId}-${r.severity}-${r.via}-${r.classAId}-${r.classBId}`;

beforeAll(async () => {
  await redisReady();
});

describe('health (F-45)', () => {
  it('all engines up', async () => {
    const h = await ok('health');
    expect(h.status).toBe('up');
    expect([h.postgres.status, h.neo4j.status, h.redis.status]).toEqual(['up', 'up', 'up']);
    expect(h.graphSync.pending).toBeTypeOf('number');
  });
});

describe('free slots cache (F-41, BR-18)', () => {
  it('a booked slot disappears right after commit even though the day was cached', async () => {
    const doctorId = await demoDoctorId();
    const date = day(5);
    const before = await ok('freeSlots', { as: 'registrar', params: { id: doctorId }, query: { date } }); // fills the cache
    const ctx = await redisCtx();
    expect(await ctx.client.exists(`${ctx.prefix}:slots:${doctorId}:${date}`)).toBe(1);
    const slot = before[0]!.slotStart;
    const pid = await newPatient();
    await ok('bookAppointment', { as: 'registrar', body: { patientId: pid, doctorId, startsAt: slot, reason: 'кеш' } });
    const after = await ok('freeSlots', { as: 'registrar', params: { id: doctorId }, query: { date } });
    expect(after.map((s) => s.slotStart)).not.toContain(slot);
    expect(after).toHaveLength(before.length - 1);
  });
});

describe('bed counters (F-43)', () => {
  it('equal v_beds after admit → transfer to another ward → discharge', async () => {
    expect(await apiCounts()).toEqual(await pgCounts());
    const beds = await ok('listBeds', { as: 'registrar' });
    const a = beds.find((b) => b.status === 'available')!;
    const b = beds.find((x) => x.status === 'available' && x.wardId !== a.wardId)!;
    const pid = await newPatient();
    const id = (await ok('admit', { as: 'registrar', body: { patientId: pid, bedId: a.id, doctorId: await demoDoctorId(), reason: 'тест' } })).id;
    expect(await apiCounts()).toEqual(await pgCounts());
    await ok('transfer', { as: 'registrar', params: { id }, body: { bedId: b.id } });
    expect(await apiCounts()).toEqual(await pgCounts());
    await ok('discharge', { as: 'registrar', params: { id }, body: { summary: 'Виписаний' } });
    expect(await apiCounts()).toEqual(await pgCounts());
  });
});

describe('logout and revocation (F-42, BR-16)', () => {
  it('a revoked token gets 401; logging out twice is 401', async () => {
    const t = await freshToken();
    await ok('me', { token: t });
    await ok('logout', { token: t });
    await fails('me', { token: t }, 401, 'UNAUTHENTICATED');
    await fails('logout', { token: t }, 401, 'UNAUTHENTICATED');
    await ok('me', { token: await freshToken() }); // other sessions are unaffected
  });

  it('Redis down: logout still works and this process rejects the token (D-28)', async () => {
    await withEnv(REDIS_DOWN, async () => {
      const t = await freshToken();
      await ok('me', { token: t }); // fail-open check while Redis is down
      await ok('logout', { token: t });
      await fails('me', { token: t }, 401, 'UNAUTHENTICATED');
    });
  });
});

describe('degradation (D-28)', () => {
  it('Redis down: triage 503, bed counts from PG, free slots from PG, health degraded', async () => {
    await withEnv(REDIS_DOWN, async () => {
      await fails('triageList', { as: 'registrar' }, 503, 'QUEUE_UNAVAILABLE');
      await fails('triageAdd', { as: 'registrar', body: { patientName: 'X', esi: 2, complaint: 'біль' } }, 503, 'QUEUE_UNAVAILABLE');
      const counts = await ok('bedCounts', { as: 'registrar' });
      expect(counts.source).toBe('postgres');
      expect(Object.fromEntries(counts.items.map((i) => [i.wardId, { free: i.free, occupied: i.occupied }]))).toEqual(await pgCounts());
      expect((await ok('freeSlots', { as: 'registrar', params: { id: await demoDoctorId() }, query: { date: day(6) } })).length).toBeGreaterThan(0);
      const h = await ok('health');
      expect(h).toMatchObject({ status: 'degraded', postgres: { status: 'up' }, redis: { status: 'down' } });
    });
  });

  it('Neo4j down: tracing 503, interactions fall back to PG with the same rows, health degraded', async () => {
    const meds = [await medId('Клопідогрел'), await medId('Еноксапарин'), await medId('Ібупрофен')];
    const viaGraph = await ok('checkInteractions', { as: 'doctor', body: { medicationIds: meds } });
    expect(viaGraph.engine).toBe('neo4j');
    expect(viaGraph.interactions.length).toBeGreaterThan(0);
    await withEnv(NEO4J_DOWN, async () => {
      const q = { personKind: 'patient', personId: 1, from: '2026-01-01T00:00:00Z', to: '2026-01-15T00:00:00Z' };
      await fails('traceContacts', { as: 'doctor', query: q }, 503, 'GRAPH_UNAVAILABLE');
      const viaPg = await ok('checkInteractions', { as: 'doctor', body: { medicationIds: meds } });
      expect(viaPg.engine).toBe('postgres');
      expect(viaPg.interactions.map(rowKey).sort()).toEqual(viaGraph.interactions.map(rowKey).sort());
      expect(viaPg.maxSeverity).toBe(viaGraph.maxSeverity);
      expect((await ok('health')).neo4j.status).toBe('down');
    });
  });
});

describe('graph routes (F-35, F-36, F-37)', () => {
  it('trace = PG fn_trace_contacts on the same data; path reaches a hop-1 contact in one hop', async () => {
    await drainOutbox(); // writes of earlier tests → Neo4j
    const doctorId = await demoDoctorId();
    const staffId = (await pool.query<{ id: number }>('SELECT id FROM v_staff WHERE doctor_id = $1', [doctorId])).rows[0]!.id;
    const to = new Date();
    const from = new Date(to.getTime() - 14 * 86_400_000);
    const q = { personKind: 'staff', personId: staffId, from: from.toISOString(), to: to.toISOString(), depth: 2 };
    const r = await ok('traceContacts', { as: 'doctor', query: q });
    expect(r).toMatchObject({ engine: 'neo4j', index: { kind: 'staff', id: staffId, role: 'doctor' }, depth: 2 });
    expect(r.lagMs).toBe(0);
    expect(r.contacts.length).toBeGreaterThan(0);
    const { rows } = await pool.query<{ person_kind: string; person_id: number; hops: number }>(
      'SELECT person_kind, person_id, hops FROM fn_trace_contacts($1, $2, $3, $4, $5)', ['staff', staffId, from, to, 2]);
    const key = (k: string, id: number, h: number) => `${k}:${id}:${h}`;
    expect(r.contacts.map((c) => key(c.kind, c.id, c.hops)).sort()).toEqual(rows.map((x) => key(x.person_kind, x.person_id, x.hops)).sort());

    const c = r.contacts.find((x) => x.hops === 1)!;
    const p = await ok('exposurePath', { as: 'doctor', query: { aKind: 'staff', aId: staffId, bKind: c.kind, bId: c.id, from: q.from, to: q.to } });
    expect(p).toMatchObject({ found: true, hops: 1, engine: 'neo4j' });
    expect(p.steps.map((s) => s.type)).toEqual(['person', 'place', 'person']);
  });

  it('BR-12 limits come from the contract; registrar may not trace', async () => {
    await fails('traceContacts', { as: 'doctor', query: { personId: 1, from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' } }, 400, 'VALIDATION_ERROR');
    await fails('traceContacts', { as: 'registrar', query: { personId: 1, from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' } }, 403);
  });

  it('BR-13: a major interaction blocks the visit until it is acknowledged', async () => {
    const doctorId = await demoDoctorId();
    const pid = await newPatient();
    const startsAt = await freeSlot(doctorId, 7);
    const appt = (await ok('bookAppointment', { as: 'registrar', body: { patientId: pid, doctorId, startsAt, reason: 'BR-13' } })).id;
    const item = (medicationId: number) => ({ medicationId, dosage: '1 таб', frequency: '1 раз на день', durationDays: 7, quantity: 7 });
    const body = {
      conclusion: 'Тест взаємодій',
      diagnoses: [{ icd10Code: 'I10', kind: 'primary' }],
      prescription: { items: [item(await medId('Клопідогрел')), item(await medId('Еноксапарин'))] },
    };
    const check = await ok('checkInteractions', { as: 'doctor', body: { medicationIds: body.prescription.items.map((i) => i.medicationId), patientId: pid } });
    expect(check).toMatchObject({ maxSeverity: 'major', requiresAcknowledgement: true });
    const e = await fails('completeVisit', { as: 'doctor', params: { id: appt }, body }, 422, 'BUSINESS_RULE');
    expect(e.message).toContain('major');
    const done = await ok('completeVisit', { as: 'doctor', params: { id: appt }, body: { ...body, interactionsAcknowledged: true } });
    expect(done.prescriptionId).toBeTypeOf('number');
  });
});

describe('triage (F-40, BR-14)', () => {
  it('pops by ESI, then arrival', async () => {
    const add = (patientName: string, esi: number) => ok('triageAdd', { as: 'registrar', body: { patientName, esi, complaint: 'тест' } });
    await add('C', 3);
    await add('A', 1);
    await add('B', 2);
    await add('A2', 1);
    const list = await ok('triageList', { as: 'registrar' });
    expect(list.items.map((i) => i.patientName)).toEqual(['A', 'A2', 'B', 'C']);
    expect(list.items.map((i) => i.position)).toEqual([1, 2, 3, 4]);
    const order: string[] = [];
    for (let i = 0; i < 4; i++) order.push((await ok('triageCallNext', { as: 'doctor' })).entry!.patientName);
    expect(order).toEqual(['A', 'A2', 'B', 'C']);
    expect(await ok('triageCallNext', { as: 'doctor' })).toEqual({ entry: null, remaining: 0 });
  });
});

describe('ICU (F-44)', () => {
  it('beds list the latest reading; SSE delivers vitals and a critical alert', async () => {
    const icu = await ok('icuBeds', { as: 'doctor' });
    expect(icu.length).toBeGreaterThan(0);
    const bedId = icu[0]!.bedId;

    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const abort = new AbortController();
    const events: IcuStreamEvent[] = [];
    try {
      const res = await fetch(`http://localhost:${port}${routes.icuStream.path}`, {
        headers: { Authorization: `Bearer ${await freshToken('doctor')}` },
        signal: abort.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const until = async (pred: () => boolean, ms: number) => {
        const deadline = Date.now() + ms;
        while (!pred() && Date.now() < deadline) {
          const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now()))]);
          if (!chunk || chunk.done) break;
          buf += decoder.decode(chunk.value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const line = buf.slice(0, i).replace(/^data: /, '');
            buf = buf.slice(i + 2);
            events.push(routes.icuStream.output.parse(JSON.parse(line)));
          }
        }
      };
      await until(() => events.some((e) => e.type === 'ping'), 3_000);
      await ingestVitals(await redisCtx(), { bedId, hr: 35, spo2: 97, sbp: 120, dbp: 80, rr: 16, temp: 36.6 });
      await until(() => events.some((e) => e.type === 'vitals') && events.some((e) => e.type === 'alert'), 3_000);
    } finally {
      abort.abort();
      server.close();
    }
    const v = events.find((e) => e.type === 'vitals');
    const a = events.find((e) => e.type === 'alert');
    expect(v).toMatchObject({ type: 'vitals', bedId, vitals: { hr: 35 } });
    expect(a).toMatchObject({ type: 'alert', alert: { bedId, violations: [{ sign: 'hr', value: 35 }] } });

    const after = await ok('icuBeds', { as: 'doctor' });
    expect(after.find((b) => b.bedId === bedId)).toMatchObject({ alerting: true, vitals: { hr: 35 } });
  });

  it('alerts persisted by the consumer group are listed (icu_alerts)', async () => {
    const { startAlertConsumer } = await import('@clinic/redis');
    const { UnitOfWork } = await import('../src/db/UnitOfWork');
    const ctx = await redisCtx();
    const stop = await startAlertConsumer(ctx, (r) =>
      UnitOfWork.run(null, (uow) => uow.lab2.recordAlert({ ...r, at: r.vitals.at })).then(() => undefined), { consumer: 'api-test' });
    try {
      const bedId = (await ok('icuBeds', { as: 'doctor' }))[0]!.bedId;
      const { streamId } = await ingestVitals(ctx, { bedId, hr: 80, spo2: 85, sbp: 120, dbp: 80, rr: 16, temp: 36.6 });
      let list: Awaited<ReturnType<typeof ok<'icuAlerts'>>> = [];
      for (let i = 0; i < 40 && !list.some((x) => x.id === streamId); i++) {
        await new Promise((r) => setTimeout(r, 100));
        list = await ok('icuAlerts', { as: 'doctor', query: { bedId } });
      }
      expect(list.find((x) => x.id === streamId)).toMatchObject({ bedId, violations: [{ sign: 'spo2', value: 85 }] });
    } finally {
      await stop();
    }
  });
});

// keep `hit` referenced for ad-hoc debugging of raw responses
void hit;
