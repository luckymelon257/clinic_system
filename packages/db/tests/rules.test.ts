import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, closePool, expectSqlState, one, tx } from './db';

const ADMIN = 'admin@clinic.local';
const REGISTRAR = 'registrar@clinic.local';
const DOCTOR = 'doctor@clinic.local';
const CASHIER = 'cashier@clinic.local';
const LAB = 'lab@clinic.local';

let doctorId = 0; // demo doctor, works every day 08:00–20:00, 30-min slots
let patientId = 0; // demo patient (80% insurance)

beforeAll(async () => {
  await tx(null, async (c) => {
    doctorId = (await one<{ id: number }>(c, "SELECT id FROM v_doctors WHERE email = 'doctor@clinic.local'")).id;
    patientId = (await one<{ patient_id: number }>(c, "SELECT patient_id FROM v_users WHERE email = 'patient@clinic.local'"))
      .patient_id;
  });
});
afterAll(closePool);

const freeSlot = async (c: pg.PoolClient, daysAhead = 2, n = 0) =>
  (await one<{ slot_start: Date }>(c, 'SELECT slot_start FROM fn_doctor_free_slots($1, current_date + $2::int) OFFSET $3 LIMIT 1', [
    doctorId,
    daysAhead,
    n,
  ])).slot_start;

const newPatient = (c: pg.PoolClient, last = 'Тестовий') =>
  call(c, 'sp_patient_create', [last, 'Пацієнт', null, '1990-01-01', 'male', '+380991112233', null, null, null, null, null]);

const availableBed = async (c: pg.PoolClient, n = 0) =>
  (await one<{ id: number }>(c, "SELECT id FROM v_beds WHERE status = 'available' ORDER BY id OFFSET $1 LIMIT 1", [n])).id;

describe('BR-1 no overlapping appointments per doctor (EXCLUDE)', () => {
  it('books a free slot, then rejects the same slot', () =>
    tx(REGISTRAR, async (c) => {
      const slot = await freeSlot(c);
      const id = await call(c, 'sp_appointment_book', [patientId, doctorId, slot, 'Тест']);
      expect(id).toBeGreaterThan(0);
      const other = await newPatient(c);
      await expectSqlState(c, 'CALL sp_appointment_book($1, $2, $3, NULL, NULL)', [other, doctorId, slot], 'P0409');
      // the constraint itself, bypassing the procedure
      await expectSqlState(
        c,
        "INSERT INTO appointments (patient_id, doctor_id, starts_at, ends_at) VALUES ($1, $2, $3, $3::timestamptz + interval '10 minutes')",
        [other, doctorId, slot],
        '23P01',
      );
    }));

  it('a cancelled appointment frees the slot', () =>
    tx(REGISTRAR, async (c) => {
      const slot = await freeSlot(c);
      const id = await call(c, 'sp_appointment_book', [patientId, doctorId, slot, null]);
      await c.query('CALL sp_appointment_cancel($1, $2)', [id, 'Тест']);
      expect(await call(c, 'sp_appointment_book', [await newPatient(c), doctorId, slot, null])).toBeGreaterThan(id);
    }));
});

describe('BR-2 one active admission per bed (EXCLUDE)', () => {
  it('admits to an available bed, rejects a second active admission on it', () =>
    tx(REGISTRAR, async (c) => {
      const bed = await availableBed(c);
      expect(await call(c, 'sp_admit_patient', [patientId, bed, doctorId, 'Тест'])).toBeGreaterThan(0);
      const other = await newPatient(c);
      await expectSqlState(c, 'CALL sp_admit_patient($1, $2, $3, NULL, NULL)', [other, bed, doctorId], 'P0409');
      await expectSqlState(
        c,
        'INSERT INTO admissions (patient_id, bed_id, doctor_id) VALUES ($1, $2, $3)',
        [other, bed, doctorId],
        '23P01',
      );
    }));
});

describe('BR-3 appointment only inside the doctor schedule', () => {
  it('rejects a time outside working hours and a time off the slot grid', () =>
    tx(REGISTRAR, async (c) => {
      const night = (await one<{ t: Date }>(c, "SELECT (current_date + 2 + time '03:00')::timestamptz AS t")).t;
      await expectSqlState(c, 'CALL sp_appointment_book($1, $2, $3, NULL, NULL)', [patientId, doctorId, night], 'P0020');
      const slot = await freeSlot(c);
      const offGrid = new Date(slot.getTime() + 10 * 60_000);
      await expectSqlState(c, 'CALL sp_appointment_book($1, $2, $3, NULL, NULL)', [patientId, doctorId, offGrid], 'P0020');
    }));

  it('accepts a slot from fn_doctor_free_slots and sets duration from slot_minutes', () =>
    tx(REGISTRAR, async (c) => {
      const slot = await freeSlot(c, 3);
      const id = await call(c, 'sp_appointment_book', [patientId, doctorId, slot, null]);
      const a = await one<{ minutes: number }>(
        c,
        'SELECT (extract(epoch FROM ends_at - starts_at) / 60)::int AS minutes FROM v_appointments WHERE id = $1',
        [id],
      );
      expect(a.minutes).toBe(30);
    }));
});

describe('BR-4 soft-deleted patient / doctor cannot be booked', () => {
  it('rejects a deleted patient (P0004) and a deleted doctor (P0005), accepts active ones', () =>
    tx(ADMIN, async (c) => {
      const slot = await freeSlot(c);
      const p = await newPatient(c);
      await c.query("CALL sp_soft_delete('patients', $1)", [p]);
      await expectSqlState(c, 'CALL sp_appointment_book($1, $2, $3, NULL, NULL)', [p, doctorId, slot], 'P0004');
      await c.query("CALL sp_soft_delete('doctors', $1)", [doctorId]);
      await expectSqlState(c, 'CALL sp_appointment_book($1, $2, $3, NULL, NULL)', [patientId, doctorId, slot], 'P0005');
      await c.query("CALL sp_restore('doctors', $1)", [doctorId]);
      expect(await call(c, 'sp_appointment_book', [patientId, doctorId, slot, null])).toBeGreaterThan(0);
    }));
});

describe('BR-5 medical documents are never deleted', () => {
  it('DELETE on medical_records / diagnoses / payments raises P0403; records can be supplemented', () =>
    tx(ADMIN, async (c) => {
      const rec = await one<{ id: number }>(c, 'SELECT id FROM medical_records ORDER BY id LIMIT 1');
      await expectSqlState(c, 'DELETE FROM medical_records WHERE id = $1', [rec.id], 'P0403');
      await expectSqlState(c, 'DELETE FROM diagnoses WHERE medical_record_id = $1', [rec.id], 'P0403');
      await expectSqlState(c, 'DELETE FROM payments WHERE id = (SELECT min(id) FROM payments)', [], 'P0403');
      const existing = await one<{ codes: string[] }>(
        c,
        'SELECT array_agg(icd10_code) AS codes FROM diagnoses WHERE medical_record_id = $1',
        [rec.id],
      );
      const code = (await one<{ code: string }>(c, 'SELECT code FROM icd10_codes WHERE code <> ALL ($1) LIMIT 1', [existing.codes])).code;
      expect(await call(c, 'sp_diagnosis_add', [rec.id, code, 'secondary', 'Доповнення'])).toBeGreaterThan(0);
      await expectSqlState(c, 'CALL sp_diagnosis_add($1, $2, $3, NULL, NULL)', [rec.id, 'Z99.99', 'secondary'], 'P0042');
    }));
});

describe('BR-6 DELETE on soft-delete tables becomes a soft delete', () => {
  it('keeps the patient row, sets deleted_at/deleted_by and logs SOFT_DELETE', () =>
    tx(REGISTRAR, async (c) => {
      const p = await newPatient(c);
      const res = await c.query('DELETE FROM patients WHERE id = $1', [p]);
      expect(res.rowCount).toBe(0); // trigger cancelled the physical delete
      const row = await one<{ deleted_at: Date | null; deleted_by_email: string }>(
        c,
        'SELECT p.deleted_at, u.email AS deleted_by_email FROM patients p JOIN users u ON u.id = p.deleted_by WHERE p.id = $1',
        [p],
      );
      expect(row.deleted_at).not.toBeNull();
      expect(row.deleted_by_email).toBe(REGISTRAR);
      const audit = await one<{ operation: string; changed_by_email: string }>(
        c,
        "SELECT operation, changed_by_email FROM v_audit_log WHERE table_name = 'patients' AND record_id = $1 AND operation = 'SOFT_DELETE'",
        [p],
      );
      expect(audit.changed_by_email).toBe(REGISTRAR);
      expect((await c.query('SELECT 1 FROM v_patients WHERE id = $1', [p])).rowCount).toBe(0);
      expect((await c.query("SELECT 1 FROM v_deleted_records WHERE table_name = 'patients' AND record_id = $1", [p])).rowCount).toBe(1);
    }));

  it('a table outside the whitelist is rejected by sp_soft_delete', () =>
    tx(ADMIN, async (c) => {
      await expectSqlState(c, "CALL sp_soft_delete('medical_records', 1)", [], '22023');
    }));
});

describe('BR-7 payments never exceed the amount due', () => {
  it('rejects an overpayment, accepts partial then full payment (partially_paid → paid)', () =>
    tx(CASHIER, async (c) => {
      const inv = await call(c, 'sp_invoice_create', [patientId, null, null]);
      await call(c, 'sp_invoice_add_item', [inv, 'procedure', 'Тест', 2, 500]);
      await c.query('CALL sp_invoice_issue($1, $2)', [inv, 14]);
      const due = Number((await one<{ total_due: string }>(c, 'SELECT total_due FROM v_invoices WHERE id = $1', [inv])).total_due);
      expect(due).toBe(200); // 1000 − 80% insurance
      await expectSqlState(c, 'CALL sp_payment_register($1, $2, $3, NULL, NULL)', [inv, due + 0.01, 'cash'], 'P0075');
      await call(c, 'sp_payment_register', [inv, 50, 'card', 'TX-1']);
      expect((await one<{ status: string }>(c, 'SELECT status FROM v_invoices WHERE id = $1', [inv])).status).toBe('partially_paid');
      await expectSqlState(c, 'CALL sp_payment_register($1, $2, $3, NULL, NULL)', [inv, 150.01, 'cash'], 'P0075');
      await call(c, 'sp_payment_register', [inv, 150, 'cash', null]);
      const paid = await one<{ status: string; balance: string; received_by_email: string }>(
        c,
        'SELECT i.status, i.balance, p.received_by_email FROM v_invoices i JOIN v_payments p ON p.invoice_id = i.id WHERE i.id = $1 LIMIT 1',
        [inv],
      );
      expect(paid.status).toBe('paid');
      expect(Number(paid.balance)).toBe(0);
      expect(paid.received_by_email).toBe(CASHIER);
      await expectSqlState(c, 'CALL sp_payment_register($1, $2, $3, NULL, NULL)', [inv, 1, 'cash'], 'P0073');
    }));
});

describe('BR-8 email unique case-insensitively among non-deleted users', () => {
  it('rejects a duplicate email in any case, allows reuse after soft delete', () =>
    tx(ADMIN, async (c) => {
      await expectSqlState(c, 'CALL sp_user_create($1, $2, $3, $4, NULL)', ['CASHIER@Clinic.Local', 'x', 'cashier', 'Дублікат'], 'P0409');
      await expectSqlState(
        c,
        "INSERT INTO users (email, password_hash, role_id, full_name) VALUES ('Cashier@CLINIC.local', 'x', 1, 'Дублікат')",
        [],
        '23505',
      );
      const old = (await one<{ id: number }>(c, "SELECT id FROM users WHERE email = 'cashier@clinic.local'")).id;
      await c.query("CALL sp_soft_delete('users', $1)", [old]);
      expect(await call(c, 'sp_user_create', ['Cashier@clinic.local', 'hash', 'cashier', 'Новий касир'])).toBeGreaterThan(old);
    }));
});

describe('BR-9 discharge ≥ admission, appointment end > start (CHECK)', () => {
  it('rejects inverted intervals, accepts valid ones', () =>
    tx(ADMIN, async (c) => {
      await expectSqlState(
        c,
        "INSERT INTO appointments (patient_id, doctor_id, starts_at, ends_at) VALUES ($1, $2, now() + interval '1 year', now() + interval '1 year' - interval '1 minute')",
        [patientId, doctorId],
        '23514',
      );
      await expectSqlState(
        c,
        "INSERT INTO admissions (patient_id, bed_id, doctor_id, admitted_at, discharged_at, status) VALUES ($1, $2, $3, now(), now() - interval '1 day', 'discharged')",
        [patientId, await availableBed(c), doctorId],
        '23514',
      );
      await c.query(
        "INSERT INTO admissions (patient_id, bed_id, doctor_id, admitted_at, discharged_at, status) VALUES ($1, $2, $3, now() - interval '3 days', now(), 'discharged')",
        [patientId, await availableBed(c), doctorId],
      );
    }));
});

describe('BR-10 insurance coverage 0–100 (CHECK)', () => {
  it('rejects 120%, accepts 100%', () =>
    tx(REGISTRAR, async (c) => {
      const p = await newPatient(c);
      await expectSqlState(
        c,
        "CALL sp_patient_insurance_add($1, 1, 'T-1', 120, current_date, NULL, NULL)",
        [p],
        '23514',
      );
      expect(
        await call(c, 'sp_patient_insurance_add', [p, 1, 'T-2', 100, '2020-01-01', null]),
      ).toBeGreaterThan(0);
      expect(Number((await one<{ insurance_coverage_percent: string }>(c, 'SELECT insurance_coverage_percent FROM v_patients WHERE id = $1', [p])).insurance_coverage_percent)).toBe(100);
    }));
});

describe('audit fields and audit log', () => {
  it('updated_by / updated_at come from set_config, created_* are immutable', () =>
    tx(REGISTRAR, async (c) => {
      const p = await newPatient(c, 'Аудитний');
      await c.query(
        "CALL sp_patient_update($1, 'Аудитний', 'Змінений', NULL, '1990-01-01', 'male', '+380991112233', 'a@b.example', NULL, 'O+', NULL, NULL)",
        [p],
      );
      const row = await one<{ updated_by_email: string; updated_at: Date | null; first_name: string }>(
        c,
        'SELECT updated_by_email, updated_at, first_name FROM v_patients WHERE id = $1',
        [p],
      );
      expect(row.updated_by_email).toBe(REGISTRAR);
      expect(row.updated_at).not.toBeNull();
      expect(row.first_name).toBe('Змінений');
      const log = await one<{ changed_fields: string[] }>(
        c,
        "SELECT changed_fields FROM v_audit_log WHERE table_name = 'patients' AND record_id = $1 AND operation = 'UPDATE'",
        [p],
      );
      expect(log.changed_fields).toEqual(expect.arrayContaining(['first_name', 'email', 'blood_type']));
      await expectSqlState(c, 'UPDATE patients SET created_by = NULL WHERE id = $1', [p], 'P0403');
    }));

  it('audit log never stores password hashes', () =>
    tx(ADMIN, async (c) => {
      const id = await call(c, 'sp_user_create', ['audit.user@clinic.local', '$2a$10$secret', 'registrar', 'Аудит']);
      const log = await one<{ new_data: Record<string, unknown> }>(
        c,
        "SELECT new_data FROM v_audit_log WHERE table_name = 'users' AND record_id = $1",
        [id],
      );
      expect(log.new_data).not.toHaveProperty('password_hash');
      expect(log.new_data).toHaveProperty('email', 'audit.user@clinic.local');
    }));
});

describe('sp_restore', () => {
  it('non-admin gets P0403, admin restores and RESTORE is logged', () =>
    tx(REGISTRAR, async (c) => {
      const p = await newPatient(c);
      await c.query("CALL sp_soft_delete('patients', $1)", [p]);
      await expectSqlState(c, "CALL sp_restore('patients', $1)", [p], 'P0403');
      await c.query("SELECT set_config('app.current_user_id', (SELECT id::text FROM users WHERE email = $1), true)", [ADMIN]);
      await c.query("CALL sp_restore('patients', $1)", [p]);
      expect((await c.query('SELECT 1 FROM v_patients WHERE id = $1', [p])).rowCount).toBe(1);
      await one(c, "SELECT 1 FROM audit_log WHERE table_name = 'patients' AND record_id = $1 AND operation = 'RESTORE'", [p]);
    }));
});

describe('inpatient: bed status follows admit / transfer / discharge', () => {
  it('occupies, moves and frees beds; discharge issues a stay invoice', () =>
    tx(REGISTRAR, async (c) => {
      const bedA = await availableBed(c, 0);
      const bedB = await availableBed(c, 1);
      const bedStatus = async (id: number) => (await one<{ status: string }>(c, 'SELECT status FROM v_beds WHERE id = $1', [id])).status;
      const adm = await call(c, 'sp_admit_patient', [patientId, bedA, doctorId, 'Тест']);
      expect(await bedStatus(bedA)).toBe('occupied');
      await expectSqlState(c, 'CALL sp_admit_patient($1, $2, $3, NULL, NULL)', [patientId, bedB, doctorId], 'P0409');
      await c.query('CALL sp_transfer_patient($1, $2)', [adm, bedB]);
      expect(await bedStatus(bedA)).toBe('available');
      expect(await bedStatus(bedB)).toBe('occupied');
      const inv = await call(c, 'sp_discharge_patient', [adm, 'Виписаний']);
      expect(await bedStatus(bedB)).toBe('available');
      const invoice = await one<{ status: string; admission_id: number; subtotal: string }>(
        c,
        'SELECT status, admission_id, subtotal FROM v_invoices WHERE id = $1',
        [inv],
      );
      expect(invoice).toMatchObject({ status: 'issued', admission_id: adm });
      expect(Number(invoice.subtotal)).toBeGreaterThan(0);
      await expectSqlState(c, 'CALL sp_discharge_patient($1, NULL, NULL)', [adm], 'P0060');
    }));
});

describe('finance: invoice totals follow items with insurance', () => {
  it('recalculates subtotal / insurance / total on every item', () =>
    tx(CASHIER, async (c) => {
      const inv = await call(c, 'sp_invoice_create', [patientId, null, null]);
      await call(c, 'sp_invoice_add_item', [inv, 'consultation', 'Консультація', 1, 600]);
      await call(c, 'sp_invoice_add_item', [inv, 'lab_test', 'Аналіз', 3, 80.5]);
      const i = await one<Record<string, string>>(c, 'SELECT * FROM v_invoices WHERE id = $1', [inv]);
      expect(Number(i.subtotal)).toBe(841.5);
      expect(Number(i.insurance_coverage_percent)).toBe(80);
      expect(Number(i.insurance_amount)).toBe(673.2);
      expect(Number(i.total_due)).toBe(168.3);
      expect(i.status).toBe('draft');
      expect((await c.query('SELECT 1 FROM v_invoice_items WHERE invoice_id = $1', [inv])).rowCount).toBe(2);
      await expectSqlState(c, 'CALL sp_invoice_issue($1, 14)', [await call(c, 'sp_invoice_create', [patientId, null, null])], 'P0074');
    }));
});

describe('lab: is_abnormal and order completion', () => {
  it('flags values outside ref range, leaves text results null, completes the order', () =>
    tx(DOCTOR, async (c) => {
      const order = await call(c, 'sp_lab_order_create', [patientId, doctorId, null, 'urgent', ['HGB', 'glu', 'UA']]);
      const queue = await c.query('SELECT test_code FROM v_lab_queue WHERE order_id = $1 ORDER BY test_code', [order]);
      expect(queue.rows.map((r) => r.test_code)).toEqual(['GLU', 'HGB', 'UA']);
      await expectSqlState(c, 'CALL sp_lab_order_create($1, $2, NULL, $3, $4, NULL)', [patientId, doctorId, 'routine', ['NOPE']], 'P0050');
      const t = async (code: string) => (await one<{ id: number }>(c, 'SELECT id FROM lab_test_types WHERE code = $1', [code])).id;
      await c.query("SELECT set_config('app.current_user_id', (SELECT id::text FROM users WHERE email = $1), true)", [LAB]);
      await call(c, 'sp_lab_result_record', [order, await t('HGB'), 100, null]);
      await call(c, 'sp_lab_result_record', [order, await t('GLU'), 5.0, null]);
      expect((await one<{ status: string }>(c, 'SELECT status FROM lab_orders WHERE id = $1', [order])).status).toBe('in_progress');
      await call(c, 'sp_lab_result_record', [order, await t('UA'), null, 'Без змін']);
      const res = await c.query('SELECT test_code, is_abnormal, recorded_by_email FROM v_lab_results WHERE order_id = $1 ORDER BY test_code', [order]);
      expect(res.rows).toEqual([
        { test_code: 'GLU', is_abnormal: false, recorded_by_email: LAB },
        { test_code: 'HGB', is_abnormal: true, recorded_by_email: LAB },
        { test_code: 'UA', is_abnormal: null, recorded_by_email: LAB },
      ]);
      expect((await one<{ status: string }>(c, 'SELECT status FROM lab_orders WHERE id = $1', [order])).status).toBe('completed');
      await expectSqlState(c, 'CALL sp_lab_result_record($1, $2, 1, NULL, NULL)', [order, await t('HGB')], 'P0051');
    }));
});

describe('appointments: free slots, visit completion, status guard', () => {
  it('free slots exclude booked ones', () =>
    tx(REGISTRAR, async (c) => {
      const count = async () =>
        Number((await one<{ n: string }>(c, 'SELECT count(*) AS n FROM fn_doctor_free_slots($1, current_date + 4)', [doctorId])).n);
      const before = await count();
      const slot = await freeSlot(c, 4);
      await call(c, 'sp_appointment_book', [patientId, doctorId, slot, null]);
      expect(await count()).toBe(before - 1);
      const slots = await c.query('SELECT slot_start FROM fn_doctor_free_slots($1, current_date + 4)', [doctorId]);
      expect(slots.rows.map((r) => (r.slot_start as Date).getTime())).not.toContain(slot.getTime());
    }));

  it('medical record completes the appointment; completed appointments are frozen', () =>
    tx(DOCTOR, async (c) => {
      const slot = await freeSlot(c, 5);
      const appt = await call(c, 'sp_appointment_book', [patientId, doctorId, slot, 'Огляд']);
      await c.query("CALL sp_appointment_set_status($1, 'confirmed')", [appt]);
      const rec = await call(c, 'sp_medical_record_create', [appt, null, 'Скарги', 'Огляд', 'Висновок', 'Порада']);
      await call(c, 'sp_diagnosis_add', [rec, 'i10', 'primary', null]);
      await expectSqlState(c, 'CALL sp_diagnosis_add($1, $2, $3, NULL, NULL)', [rec, 'J06.9', 'primary'], 'P0409');
      const med = (await one<{ id: number }>(c, 'SELECT id FROM v_medications ORDER BY id LIMIT 1')).id;
      const rx = await call(c, 'sp_prescription_create', [
        rec,
        null,
        JSON.stringify([{ medicationId: med, dosage: '1 таб', frequency: '2 рази', durationDays: 7, quantity: 14, instructions: null }]),
      ]);
      const p = await one<{ items: Array<Record<string, unknown>> }>(c, 'SELECT items FROM v_prescriptions WHERE id = $1', [rx]);
      expect(p.items[0]).toMatchObject({ medicationId: med, durationDays: 7, quantity: 14 });
      const a = await one<{ status: string; medical_record_id: number }>(
        c,
        'SELECT status, medical_record_id FROM v_appointments WHERE id = $1',
        [appt],
      );
      expect(a).toEqual({ status: 'completed', medical_record_id: rec });
      const mr = await one<{ diagnoses: Array<Record<string, unknown>>; diagnoses_summary: string }>(
        c,
        'SELECT diagnoses, diagnoses_summary FROM v_medical_records WHERE id = $1',
        [rec],
      );
      expect(mr.diagnoses[0]).toMatchObject({ icd10Code: 'I10', kind: 'primary', medicalRecordId: rec });
      expect(mr.diagnoses_summary).toContain('I10');
      await expectSqlState(c, "CALL sp_appointment_set_status($1, 'scheduled')", [appt], 'P0031');
      await expectSqlState(c, 'CALL sp_appointment_cancel($1, $2)', [appt, 'x'], 'P0031');
      const hist = await c.query("SELECT event_type FROM fn_patient_history($1) WHERE ref_id IN ($2, $3)", [patientId, appt, rec]);
      expect(hist.rows.map((r) => r.event_type)).toEqual(expect.arrayContaining(['appointment', 'diagnosis', 'prescription']));
    }));

  it('rejects invalid status transitions and past bookings', () =>
    tx(REGISTRAR, async (c) => {
      const appt = await call(c, 'sp_appointment_book', [patientId, doctorId, await freeSlot(c, 6), null]);
      await c.query("CALL sp_appointment_set_status($1, 'in_progress')", [appt]);
      await expectSqlState(c, "CALL sp_appointment_set_status($1, 'confirmed')", [appt], 'P0031');
      const yesterday = (await one<{ t: Date }>(c, "SELECT (current_date - 1 + time '10:00')::timestamptz AS t")).t;
      await expectSqlState(c, 'CALL sp_appointment_book($1, $2, $3, NULL, NULL)', [patientId, doctorId, yesterday], 'P0021');
    }));
});

describe('auth, search, reports', () => {
  it('fn_auth_user returns a bcrypt hash that verifies with the demo password', () =>
    tx(null, async (c) => {
      const u = await one<{ role: string; ok: boolean; doctor_id: number | null }>(
        c,
        "SELECT role, password_hash = crypt('doctor123', password_hash) AS ok, doctor_id FROM fn_auth_user('Doctor@Clinic.local')",
      );
      expect(u).toEqual({ role: 'doctor', ok: true, doctor_id: doctorId });
      const uid = (await one<{ id: number }>(c, 'SELECT id FROM v_users WHERE email = $1', [DOCTOR])).id;
      await c.query('CALL sp_user_touch_login($1)', [uid]);
      expect((await one<{ last_login_at: Date | null }>(c, 'SELECT last_login_at FROM v_users WHERE email = $1', [DOCTOR])).last_login_at).not.toBeNull();
    }));

  it('fn_search_patients finds by fuzzy name and by phone digits', () =>
    tx(null, async (c) => {
      const byName = await c.query("SELECT full_name FROM fn_search_patients('Иваненко Петро', 5)");
      expect(byName.rows[0]?.full_name).toBe('Іваненко Петро Олександрович');
      const byPhone = await c.query("SELECT id FROM fn_search_patients('067 123 45 67', 5)");
      expect(byPhone.rows.map((r) => r.id)).toContain(patientId);
    }));

  it('sp_refresh_reports refreshes mv_monthly_revenue concurrently', () =>
    tx(CASHIER, async (c) => {
      const sum = async () =>
        Number((await one<{ s: string }>(c, "SELECT coalesce(sum(total), 0) AS s FROM mv_monthly_revenue WHERE month = date_trunc('month', now())::date")).s);
      const before = await sum();
      const inv = await call(c, 'sp_invoice_create', [patientId, null, null]);
      await call(c, 'sp_invoice_add_item', [inv, 'procedure', 'Тест', 1, 1000]);
      await c.query('CALL sp_invoice_issue($1, 14)', [inv]);
      await call(c, 'sp_payment_register', [inv, 200, 'cash', null]);
      expect(await sum()).toBe(before);
      await c.query('CALL sp_refresh_reports()');
      expect(await sum()).toBeCloseTo(before + 200, 2);
    }));
});
