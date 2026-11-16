import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { call, closePool, expectSqlState, one, tx } from './db';
import { TEST_URL } from './url';

// Migration 009 (Lab 2): rooms, staff shifts (BR-15), graph outbox (D-23, D-32), claim / ack.
const ADMIN = 'admin@clinic.local';
const REGISTRAR = 'registrar@clinic.local';

const raw = new pg.Pool({ connectionString: TEST_URL, max: 3 });
afterAll(async () => {
  await raw.end();
  await closePool();
});

const nurse = (c: pg.PoolClient) => one<{ id: number }>(c, "SELECT id FROM staff WHERE role = 'nurse' ORDER BY id LIMIT 1");
const ward = (c: pg.PoolClient, n = 0) => one<{ id: number }>(c, 'SELECT id FROM wards ORDER BY id OFFSET $1 LIMIT 1', [n]);
const lastOutbox = (c: pg.PoolClient) =>
  one<{ entity: string; entity_key: string; op: string; payload: Record<string, unknown> }>(
    c, 'SELECT entity, entity_key, op, payload FROM graph_outbox ORDER BY id DESC LIMIT 1');

describe('rooms (D-21)', () => {
  it('every reference bed has a room in its own ward', () =>
    tx(null, async (c) => {
      const r = await one<{ beds: number; with_room: number; same_ward: number }>(c, `
        SELECT count(*)::int AS beds, count(b.room_id)::int AS with_room, count(r.id) FILTER (WHERE r.ward_id = b.ward_id)::int AS same_ward
        FROM beds b LEFT JOIN rooms r ON r.id = b.room_id`);
      expect(r.beds).toBeGreaterThan(0);
      expect(r).toEqual({ beds: r.beds, with_room: r.beds, same_ward: r.beds });
    }));

  it('a new bed without room gets the first room of its ward; a room of another ward is rejected', () =>
    tx(ADMIN, async (c) => {
      const w = await ward(c, 0);
      const first = await one<{ id: number }>(c, 'SELECT min(id) AS id FROM rooms WHERE ward_id = $1', [w.id]);
      const bed = await one<{ room_id: number }>(c, "INSERT INTO beds (ward_id, bed_number) VALUES ($1, 'Z9') RETURNING room_id", [w.id]);
      expect(bed.room_id).toBe(first.id);
      const other = await one<{ id: number }>(c, 'SELECT id FROM rooms WHERE ward_id <> $1 LIMIT 1', [w.id]);
      await expectSqlState(c, "INSERT INTO beds (ward_id, room_id, bed_number) VALUES ($1, $2, 'Z8')", [w.id, other.id], '23503');
    }));
});

describe('BR-15 staff shifts do not overlap', () => {
  it('rejects an overlapping shift of the same person, allows back-to-back and other staff', () =>
    tx(ADMIN, async (c) => {
      const s = await nurse(c);
      const w = await ward(c);
      const other = await one<{ id: number }>(c, 'SELECT id FROM staff WHERE id <> $1 ORDER BY id LIMIT 1', [s.id]);
      await call(c, 'sp_staff_shift_add', [s.id, w.id, '2030-01-01T08:00Z', '2030-01-01T16:00Z']);
      await call(c, 'sp_staff_shift_add', [s.id, w.id, '2030-01-01T16:00Z', '2030-01-02T00:00Z']); // [) — touching is fine
      await call(c, 'sp_staff_shift_add', [other.id, w.id, '2030-01-01T10:00Z', '2030-01-01T18:00Z']);
      await expectSqlState(c, 'CALL sp_staff_shift_add($1, $2, $3, $4, NULL)', [s.id, w.id, '2030-01-01T15:00Z', '2030-01-01T17:00Z'], '23P01');
    }));

  it('validates staff, ward and times', () =>
    tx(ADMIN, async (c) => {
      const s = await nurse(c);
      const w = await ward(c);
      await expectSqlState(c, 'CALL sp_staff_shift_add($1, $2, $3, $4, NULL)', [-1, w.id, '2030-01-01T08:00Z', '2030-01-01T16:00Z'], 'P0002');
      await expectSqlState(c, 'CALL sp_staff_shift_add($1, $2, $3, $4, NULL)', [s.id, -1, '2030-01-01T08:00Z', '2030-01-01T16:00Z'], 'P0002');
      await expectSqlState(c, 'CALL sp_staff_shift_add($1, $2, $3, $4, NULL)', [s.id, w.id, '2030-01-01T16:00Z', '2030-01-01T08:00Z'], 'P0070');
    }));
});

describe('graph outbox (D-23, D-32)', () => {
  it('admission writes one presence event with room + ward edges, open stay t = 9e15', () =>
    tx(REGISTRAR, async (c) => {
      const p = await call(c, 'sp_patient_create', ['Outbox', 'Тест', null, '1990-01-01', 'male', null, null, null, null, null, null]);
      const bed = await one<{ id: number; room_id: number; ward_id: number }>(c,
        "SELECT b.id, b.room_id, b.ward_id FROM beds b WHERE b.status = 'available' ORDER BY id LIMIT 1");
      const doc = await one<{ id: number }>(c, 'SELECT id FROM doctors ORDER BY id LIMIT 1');
      const adm = await call(c, 'sp_admit_patient', [p, bed.id, doc.id, 'тест']);
      const ev = await lastOutbox(c);
      expect(ev).toMatchObject({ entity: 'presence', entity_key: `admission:${adm}`, op: 'upsert' });
      const edges = (ev.payload as { edges: { placeKind: string; placeId: number; t: number }[] }).edges;
      expect(edges.map((e) => [e.placeKind, e.placeId])).toEqual([['room', bed.room_id], ['ward', bed.ward_id]]);
      expect(edges.every((e) => e.t === 9e15)).toBe(true);
    }));

  it('office events carry the doctor name, like v_graph_places (012)', () =>
    tx(ADMIN, async (c) => {
      const d = await one<{ id: number; name: string }>(c, 'SELECT d.id, u.full_name AS name FROM doctors d JOIN users u ON u.id = d.user_id ORDER BY d.id LIMIT 1');
      await c.query('UPDATE doctors SET consultation_fee = consultation_fee + 1 WHERE id = $1', [d.id]);
      const ev = await lastOutbox(c);
      expect(ev).toMatchObject({ entity: 'office', entity_key: String(d.id), payload: { id: d.id, name: d.name } });
    }));

  it('a cancelled appointment replaces its edges with an empty list', () =>
    tx(REGISTRAR, async (c) => {
      const a = await one<{ id: number }>(c, "SELECT id FROM appointments WHERE status = 'scheduled' ORDER BY id LIMIT 1");
      await c.query('CALL sp_appointment_cancel($1, $2)', [a.id, 'тест']);
      const ev = await lastOutbox(c);
      expect(ev).toMatchObject({ entity: 'presence', entity_key: `appointment:${a.id}` });
      expect(ev.payload).toMatchObject({ src: 'appointment', srcId: a.id, edges: [] });
    }));

  it('is written in the same transaction: rollback leaves no event', async () => {
    const count = async () => Number((await raw.query('SELECT count(*) FROM graph_outbox')).rows[0].count);
    const before = await count();
    const c = await raw.connect();
    try {
      await c.query('BEGIN');
      await c.query("UPDATE patients SET first_name = first_name || '' WHERE id = (SELECT min(id) FROM patients)");
      expect(Number((await c.query('SELECT count(*) FROM graph_outbox')).rows[0].count)).toBe(before + 1);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    expect(await count()).toBe(before);
  });

  it('two workers claim disjoint batches (SKIP LOCKED); ack marks processed, error returns to queue', async () => {
    const [a, b] = [await raw.connect(), await raw.connect()];
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const ra = (await a.query<{ id: string }>("SELECT id FROM fn_graph_outbox_claim('w1', 5)")).rows.map((r) => r.id);
      const rb = (await b.query<{ id: string }>("SELECT id FROM fn_graph_outbox_claim('w2', 5)")).rows.map((r) => r.id);
      expect(ra).toHaveLength(5);
      expect(rb).toHaveLength(5);
      expect(ra.filter((id) => rb.includes(id))).toEqual([]);
      expect(ra.map(Number)).toEqual([...ra.map(Number)].sort((x, y) => x - y)); // in id order
      await a.query('CALL sp_graph_outbox_ack($1)', [ra]);
      await b.query('CALL sp_graph_outbox_ack($1, $2)', [rb, 'neo4j down']); // each worker acks its own batch
      await b.query('COMMIT');
      const st = (await a.query<{ done: number; failed: number }>(
        'SELECT count(*) FILTER (WHERE id = ANY($1) AND processed_at IS NOT NULL)::int AS done, count(*) FILTER (WHERE id = ANY($2) AND processed_at IS NULL AND claimed_at IS NULL AND last_error IS NOT NULL)::int AS failed FROM graph_outbox',
        [ra, rb])).rows[0]!;
      expect(st).toEqual({ done: 5, failed: 5 });
    } finally {
      await a.query('ROLLBACK');
      await b.query('ROLLBACK');
      a.release();
      b.release();
    }
  });

  it('sync status reports pending events and lag', () =>
    tx(null, async (c) => {
      const s = await one<{ pending: number; lag_ms: string }>(c, 'SELECT pending, lag_ms FROM v_graph_sync_status');
      expect(s.pending).toBeGreaterThan(0); // seeds wrote events, no worker in tests
      expect(Number(s.lag_ms)).toBeGreaterThan(0);
    }));
});

describe('graph model views', () => {
  it('v_graph_counts PRESENT / TAKES match the model views; interaction pairs are ordered', () =>
    tx(ADMIN, async (c) => {
      const r = await one<{ ok: boolean }>(c, `
        SELECT (SELECT count FROM v_graph_counts WHERE label = 'PRESENT') = (SELECT count(*) FROM v_presence)
           AND (SELECT count FROM v_graph_counts WHERE label = 'TAKES') = (SELECT count(*) FROM v_takes) AS ok`);
      expect(r.ok).toBe(true);
      const m = await one<{ a: number; b: number }>(c, 'SELECT medication_a AS a, medication_b AS b FROM medication_interactions LIMIT 1');
      await expectSqlState(c, "INSERT INTO medication_interactions (medication_a, medication_b, severity) VALUES ($1, $2, 'minor')", [m.b, m.a], '23514');
    }));

  it('cancelled / no-show appointments give no presence; staff doctor is present with the patient', () =>
    tx(null, async (c) => {
      const r = await one<{ bad: number; pairs: number; appts: number }>(c, `
        SELECT (SELECT count(*) FROM v_presence p JOIN appointments a ON a.id = p.src_id
                WHERE p.src = 'appointment' AND a.status IN ('cancelled', 'no_show'))::int AS bad,
               (SELECT count(*) FROM v_presence WHERE src = 'appointment' AND person_kind = 'staff')::int AS pairs,
               (SELECT count(*) FROM appointments WHERE status NOT IN ('cancelled', 'no_show'))::int AS appts`);
      expect(r.bad).toBe(0);
      expect(r.pairs).toBe(r.appts); // every demo doctor has a staff row
    }));
});
