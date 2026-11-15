import { afterAll, describe, expect, it } from 'vitest';
import { closePool, one, tx } from './db';

// Migration 011: PG side of the Redis features (triage reference, ICU alerts / vitals, BR-17 thresholds).
afterAll(closePool);

describe('BR-17 fn_icu_violations', () => {
  it('boundaries are strict (< 40 alerts at 39, not at 40; > 39.5 alerts at 39.6)', () =>
    tx(null, async (c) => {
      const v = async (hr: number, spo2: number, sbp: number, rr: number, temp: number) =>
        (await one<{ v: { rule: string }[] }>(c, 'SELECT fn_icu_violations($1, $2, $3, 75, $4, $5) AS v', [hr, spo2, sbp, rr, temp])).v.map((x) => x.rule);
      expect(await v(40, 88, 80, 8, 39.5)).toEqual([]);
      expect(await v(140, 100, 200, 30, 36)).toEqual([]);
      expect(await v(39, 87, 79, 7, 39.6)).toEqual(['< 40', '< 88', '< 80', '< 8', '> 39.5']);
      expect(await v(141, 95, 201, 31, 36)).toEqual(['> 140', '> 200', '> 30']);
    }));
});

describe('ICU vitals and alerts', () => {
  it('sp_icu_vitals_insert stores the reading and records an alert for the active patient only on violation', () =>
    tx('registrar@clinic.local', async (c) => {
      const bed = await one<{ bed_id: number }>(c, "SELECT bed_id FROM v_icu_beds WHERE status = 'available' ORDER BY bed_id LIMIT 1");
      const p = await one<{ id: number }>(c, "SELECT id FROM patients p WHERE NOT EXISTS (SELECT 1 FROM admissions a WHERE a.patient_id = p.id AND a.status = 'active') ORDER BY id LIMIT 1");
      const doc = await one<{ id: number }>(c, 'SELECT id FROM doctors ORDER BY id LIMIT 1');
      await c.query('CALL sp_admit_patient($1, $2, $3, $4, NULL)', [p.id, bed.bed_id, doc.id, 'ICU']);
      const ok = await one<{ p_violations: unknown[] }>(c, 'CALL sp_icu_vitals_insert($1, now(), 80, 97, 120, 75, 16, 36.8, NULL)', [bed.bed_id]);
      expect(ok.p_violations).toEqual([]);
      const bad = await one<{ p_violations: { sign: string }[] }>(c, 'CALL sp_icu_vitals_insert($1, now(), 80, 85, 120, 75, 16, 36.8, NULL)', [bed.bed_id]);
      expect(bad.p_violations.map((x) => x.sign)).toEqual(['spo2']);
      const a = await one<{ patient_id: number; n: number }>(c,
        "SELECT max(patient_id) AS patient_id, count(*)::int AS n FROM v_icu_alerts WHERE bed_id = $1 AND stream_id LIKE 'pg:%'", [bed.bed_id]);
      expect(a).toEqual({ patient_id: p.id, n: 1 });
      expect((await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM icu_vitals_pg WHERE bed_id = $1', [bed.bed_id])).n).toBe(2);
    }));

  it('sp_icu_alert_record is idempotent on the stream id', () =>
    tx(null, async (c) => {
      const bed = await one<{ bed_id: number }>(c, 'SELECT bed_id FROM v_icu_beds ORDER BY bed_id LIMIT 1');
      const args = ['1700000000000-0', bed.bed_id, null, '[{"sign":"hr","value":30,"rule":"< 40"}]', '{"hr":30}', '2030-01-01T00:00Z'];
      const first = await one<{ p_id: string | null }>(c, 'CALL sp_icu_alert_record($1, $2, $3, $4, $5, $6, NULL)', args);
      const again = await one<{ p_id: string | null }>(c, 'CALL sp_icu_alert_record($1, $2, $3, $4, $5, $6, NULL)', args);
      expect(first.p_id).not.toBeNull();
      expect(again.p_id).toBeNull();
    }));
});

describe('triage reference queue (BR-14)', () => {
  it('fn_triage_pop returns ESI first, then arrival; empty queue → no row', () =>
    tx(null, async (c) => {
      await c.query('TRUNCATE triage_queue_pg');
      await c.query(`INSERT INTO triage_queue_pg (patient_name, esi, complaint, arrived_at) VALUES
        ('late-1', 1, 'x', '2030-01-01T10:05Z'), ('early-3', 3, 'x', '2030-01-01T10:00Z'), ('early-1', 1, 'x', '2030-01-01T10:01Z')`);
      const names: string[] = [];
      for (;;) {
        const { rows } = await c.query<{ patient_name: string }>('SELECT patient_name FROM fn_triage_pop()');
        if (!rows[0]) break;
        names.push(rows[0].patient_name);
      }
      expect(names).toEqual(['early-1', 'late-1', 'early-3']);
    }));
});
