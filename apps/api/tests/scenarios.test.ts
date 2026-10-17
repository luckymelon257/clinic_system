import { beforeAll, describe, expect, it, vi } from 'vitest';
import { InvoiceRepository } from '../src/repositories/InvoiceRepository';
import { count, demoDoctorId, demoPatientId, fails, freeSlot, newPatient, ok, patientBody } from './helpers';

let doctorId = 0;
let patientId = 0;
let medicationId = 0;

beforeAll(async () => {
  doctorId = await demoDoctorId();
  patientId = await demoPatientId();
  medicationId = (await ok('searchMedications', { as: 'doctor' }))[0]!.id;
});

const visitBody = () => ({
  complaints: 'Кашель, температура 37.8',
  examination: 'Гіперемія зіву',
  conclusion: 'ГРВІ',
  recommendations: 'Пити багато рідини',
  diagnoses: [
    { icd10Code: 'j06.9', kind: 'primary', notes: null },
    { icd10Code: 'B34.9', kind: 'secondary' },
  ],
  prescription: { validUntil: null, items: [{ medicationId, dosage: '1 таб', frequency: '3 рази на день', durationDays: 5, quantity: 15 }] },
  labOrder: { priority: 'urgent', testCodes: ['glu'] },
});

const book = async (pid: number, slotIndex = 0, daysAhead = 3) => {
  const startsAt = await freeSlot(doctorId, daysAhead, slotIndex);
  const { id } = await ok('bookAppointment', { as: 'registrar', body: { patientId: pid, doctorId, startsAt, reason: 'Огляд' } });
  return { id, startsAt };
};

/** Rows that a visit would create, counted through the views. */
const visitRows = async (pid: number) => ({
  records: await count('v_medical_records', 'patient_id = $1', [pid]),
  diagnoses: await count('v_diagnoses', 'medical_record_id IN (SELECT id FROM v_medical_records WHERE patient_id = $1)', [pid]),
  prescriptions: await count('v_prescriptions', 'patient_id = $1', [pid]),
  labOrders: await count('v_lab_queue', 'patient_id = $1', [pid]),
  invoices: await count('v_invoices', 'patient_id = $1', [pid]),
});

describe('RegistrationService (patient + insurance + appointment, one UoW)', () => {
  it('registers all three', async () => {
    const companyId = (await ok('listInsuranceCompanies', { as: 'registrar' }))[0]!.id;
    const startsAt = await freeSlot(doctorId, 4);
    const res = await ok('register', {
      as: 'registrar',
      body: {
        patient: patientBody('Реєстрова'),
        insurance: { companyId, policyNumber: `POL-${Date.now()}`, coveragePercent: 50, validFrom: '2024-01-01' },
        appointment: { doctorId, startsAt, reason: 'Первинний огляд' },
      },
    });
    expect(res.insuranceId).toBeTypeOf('number');
    const patient = await ok('getPatient', { as: 'registrar', params: { id: res.patientId } });
    expect(patient.insuranceCoveragePercent).toBe(50);
    const appt = await ok('getAppointment', { as: 'registrar', params: { id: res.appointmentId! } });
    expect(appt).toMatchObject({ patientId: res.patientId, doctorId, status: 'scheduled' });
    expect(new Date(appt.startsAt).getTime()).toBe(new Date(startsAt).getTime());
    const ins = await ok('patientInsurances', { as: 'registrar', params: { id: res.patientId } });
    expect(ins).toHaveLength(1);
  });

  it('rolls back the patient and policy when the appointment slot is invalid', async () => {
    const lastName = `Відкат${Date.now()}`;
    const before = await count('v_patients');
    const slot = new Date(new Date(await freeSlot(doctorId, 4)).getTime() + 7 * 60_000).toISOString(); // off the slot grid
    const companyId = (await ok('listInsuranceCompanies', { as: 'registrar' }))[0]!.id;
    const e = await fails(
      'register',
      {
        as: 'registrar',
        body: {
          patient: patientBody(lastName),
          insurance: { companyId, policyNumber: `RB-${Date.now()}`, coveragePercent: 30, validFrom: '2024-01-01' },
          appointment: { doctorId, startsAt: slot },
        },
      },
      422,
      'BUSINESS_RULE',
    );
    expect(e.sqlstate).toBe('P0020');
    expect(await count('v_patients')).toBe(before);
    expect(await ok('searchPatients', { as: 'registrar', query: { q: lastName } })).toEqual([]);
  });
});

describe('VisitService.complete (record + diagnoses + prescription + lab order + invoice, one UoW)', () => {
  it('completes a booked visit', async () => {
    const pid = await newPatient();
    const appt = await book(pid);
    const res = await ok('completeVisit', { as: 'doctor', params: { id: appt.id }, body: visitBody() });
    expect(res.diagnosisIds).toHaveLength(2);

    const record = await ok('getMedicalRecord', { as: 'doctor', params: { id: res.medicalRecordId } });
    expect(record).toMatchObject({ patientId: pid, appointmentId: appt.id, conclusion: 'ГРВІ' });
    expect(record.diagnoses.map((d) => d.icd10Code).sort()).toEqual(['B34.9', 'J06.9']);
    const records = await ok('listMedicalRecords', { as: 'doctor', query: { patientId: pid } });
    expect(records.total).toBe(1);

    const [rx] = await ok('listPrescriptions', { as: 'doctor', query: { patientId: pid } });
    expect(rx).toMatchObject({ id: res.prescriptionId, medicalRecordId: res.medicalRecordId });
    expect(rx!.items[0]).toMatchObject({ medicationId, quantity: 15 });

    const queue = await ok('labQueue', { as: 'lab_technician', query: { priority: 'urgent' } });
    expect(queue.some((q) => q.orderId === res.labOrderId && q.testCode === 'GLU')).toBe(true);

    const fee = (await ok('getDoctor', { as: 'doctor', params: { id: doctorId } })).consultationFee;
    const invoice = await ok('getInvoice', { as: 'cashier', params: { id: res.invoiceId } });
    expect(invoice).toMatchObject({ patientId: pid, appointmentId: appt.id, status: 'issued', subtotal: fee, totalDue: fee });
    expect(invoice.items).toEqual([expect.objectContaining({ itemType: 'consultation', quantity: 1, unitPrice: fee, amount: fee })]);

    expect((await ok('getAppointment', { as: 'doctor', params: { id: appt.id } })).status).toBe('completed');
    const history = await ok('patientHistory', { as: 'doctor', params: { id: pid } });
    expect(history.map((h) => h.eventType)).toEqual(expect.arrayContaining(['appointment', 'diagnosis', 'prescription', 'lab_order']));

    // lab result for the order → visible to doctor
    const glu = (await ok('listLabTestTypes', { as: 'lab_technician' })).find((t) => t.code === 'GLU')!;
    const result = await ok('recordLabResult', { as: 'lab_technician', params: { id: res.labOrderId! }, body: { testTypeId: glu.id, valueNumeric: 9.5 } });
    expect(result).toMatchObject({ isAbnormal: true, recordedByEmail: 'lab@clinic.local' });
    expect(await ok('labOrderResults', { as: 'doctor', params: { id: res.labOrderId! } })).toHaveLength(1);
    expect(await ok('patientLabResults', { as: 'doctor', query: { patientId: pid } })).toHaveLength(1);

    // payments: partial ok, overpay → 422 (BR-7)
    await ok('registerPayment', { as: 'cashier', params: { id: res.invoiceId }, body: { amount: 100, method: 'cash' } });
    const overpay = await fails('registerPayment', { as: 'cashier', params: { id: res.invoiceId }, body: { amount: fee, method: 'card' } }, 422);
    expect(overpay).toMatchObject({ code: 'BUSINESS_RULE', sqlstate: 'P0075' });
    const paid = await ok('getInvoice', { as: 'cashier', params: { id: res.invoiceId } });
    expect(paid).toMatchObject({ status: 'partially_paid', paidAmount: 100, balance: fee - 100 });
    expect(paid.payments[0]).toMatchObject({ amount: 100, receivedByEmail: 'cashier@clinic.local' });
  });

  it('rolls back every step when the last step (invoice issue) fails', async () => {
    const pid = await newPatient();
    const appt = await book(pid, 1);
    const before = await visitRows(pid);

    // the real procedure, but with a non-existent invoice → P0002 from the database on the LAST step
    const spy = vi.spyOn(InvoiceRepository.prototype, 'issue').mockImplementation(function (this: InvoiceRepository) {
      return this.call('sp_invoice_issue', [-1, 14]);
    });
    try {
      await fails('completeVisit', { as: 'doctor', params: { id: appt.id }, body: visitBody() }, 404, 'NOT_FOUND');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }

    expect(await visitRows(pid)).toEqual(before);
    expect(before).toEqual({ records: 0, diagnoses: 0, prescriptions: 0, labOrders: 0, invoices: 0 });
    expect((await ok('getAppointment', { as: 'doctor', params: { id: appt.id } })).status).toBe('scheduled');

    // nothing half-written: the same visit now completes normally
    await ok('completeVisit', { as: 'doctor', params: { id: appt.id }, body: visitBody() });
    expect(await visitRows(pid)).toEqual({ records: 1, diagnoses: 2, prescriptions: 1, labOrders: 1, invoices: 1 });
  });

  it('rolls back on a bad ICD-10 code in the middle', async () => {
    const pid = await newPatient();
    const appt = await book(pid, 2);
    const body = { ...visitBody(), diagnoses: [{ icd10Code: 'J06.9', kind: 'primary' }, { icd10Code: 'Z99.99', kind: 'secondary' }] };
    const e = await fails('completeVisit', { as: 'doctor', params: { id: appt.id }, body }, 422);
    expect(e.sqlstate).toBe('P0042');
    expect(await visitRows(pid)).toEqual({ records: 0, diagnoses: 0, prescriptions: 0, labOrders: 0, invoices: 0 });
  });
});

describe('InpatientService (admit → transfer → discharge)', () => {
  it('moves beds and generates the invoice on discharge', async () => {
    const pid = await newPatient();
    const [bedA, bedB] = await ok('listBeds', { as: 'registrar', query: { status: 'available' } });
    const id = (await ok('admit', { as: 'doctor', body: { patientId: pid, bedId: bedA!.id, doctorId, reason: 'Пневмонія' } })).id;

    const bed = async (bid: number) => (await ok('listBeds', { as: 'registrar' })).find((b) => b.id === bid)!;
    expect(await bed(bedA!.id)).toMatchObject({ status: 'occupied', admissionId: id, patientId: pid });
    expect((await ok('currentAdmissions', { as: 'registrar' })).some((a) => a.id === id)).toBe(true);

    // second admission of the same patient → 409
    await fails('admit', { as: 'doctor', body: { patientId: pid, bedId: bedB!.id, doctorId } }, 409, 'CONFLICT');

    await ok('transfer', { as: 'registrar', params: { id }, body: { bedId: bedB!.id } });
    expect((await bed(bedA!.id)).status).toBe('available');
    expect(await bed(bedB!.id)).toMatchObject({ status: 'occupied', admissionId: id });

    const res = await ok('discharge', { as: 'doctor', params: { id }, body: { summary: 'Одужання' } });
    expect(res.admissionId).toBe(id);
    expect((await bed(bedB!.id)).status).toBe('available');
    expect((await ok('currentAdmissions', { as: 'registrar' })).some((a) => a.id === id)).toBe(false);

    const invoice = await ok('getInvoice', { as: 'cashier', params: { id: res.invoiceId } });
    expect(invoice).toMatchObject({ admissionId: id, patientId: pid, status: 'issued' });
    expect(invoice.items.some((i) => i.itemType === 'stay')).toBe(true);

    await fails('discharge', { as: 'doctor', params: { id }, body: { summary: 'ще раз' } }, 422, 'BUSINESS_RULE');
    const occ = await ok('occupancy', { as: 'admin' });
    expect(occ.length).toBeGreaterThan(0);
  });
});

describe('appointments + error mapping', () => {
  it('double-booking the same slot → 409', async () => {
    const appt = await book(patientId, 0, 5);
    const other = await newPatient();
    const e = await fails('bookAppointment', { as: 'registrar', body: { patientId: other, doctorId, startsAt: appt.startsAt } }, 409);
    expect(e.code).toBe('CONFLICT');
  });

  it('reschedule, status, cancel', async () => {
    const appt = await book(patientId, 1, 5);
    const later = await freeSlot(doctorId, 6);
    await ok('rescheduleAppointment', { as: 'registrar', params: { id: appt.id }, body: { startsAt: later } });
    await ok('setAppointmentStatus', { as: 'doctor', params: { id: appt.id }, body: { status: 'confirmed' } });
    await ok('cancelAppointment', { as: 'registrar', params: { id: appt.id }, body: { reason: 'Захворів' } });
    const a = await ok('getAppointment', { as: 'registrar', params: { id: appt.id } });
    expect(a).toMatchObject({ status: 'cancelled', cancelReason: 'Захворів' });
    expect(new Date(a.startsAt).getTime()).toBe(new Date(later).getTime());
    const e = await fails('setAppointmentStatus', { as: 'doctor', params: { id: appt.id }, body: { status: 'completed' } }, 422);
    expect(e.sqlstate).toBe('P0031');
    await fails('getAppointment', { as: 'registrar', params: { id: 999999 } }, 404, 'NOT_FOUND');
  });

  it('manual invoice flow + empty invoice issue → 422', async () => {
    const pid = await newPatient();
    const { id } = await ok('createInvoice', { as: 'cashier', body: { patientId: pid } });
    const e = await fails('issueInvoice', { as: 'cashier', params: { id }, body: {} }, 422);
    expect(e.sqlstate).toBe('P0074');
    await ok('addInvoiceItem', { as: 'cashier', params: { id }, body: { itemType: 'procedure', description: 'Перевʼязка', quantity: 2, unitPrice: 150.5 } });
    await ok('issueInvoice', { as: 'cashier', params: { id }, body: { dueDays: 7 } });
    const inv = await ok('getInvoice', { as: 'cashier', params: { id } });
    expect(inv).toMatchObject({ status: 'issued', subtotal: 301 });
    expect((await ok('listInvoices', { as: 'cashier', query: { unpaidOnly: 'true', patientId: pid } })).items.map((i) => i.id)).toEqual([id]);
    await ok('registerPayment', { as: 'cashier', params: { id }, body: { amount: 301, method: 'card', reference: 'TX-1' } });
    expect((await ok('listInvoices', { as: 'cashier', query: { unpaidOnly: 'true', patientId: pid } })).total).toBe(0);
    await ok('refreshReports', { as: 'cashier' });
    expect((await ok('revenue', { as: 'cashier' })).length).toBeGreaterThan(0);
  });

  it('standalone lab order + diagnosis on an existing record', async () => {
    const pid = await newPatient();
    const appt = await book(pid, 3);
    const visit = await ok('completeVisit', { as: 'doctor', params: { id: appt.id }, body: { conclusion: 'Здоровий', diagnoses: [{ icd10Code: 'Z00.0', kind: 'primary' }] } });
    expect(visit).toMatchObject({ prescriptionId: null, labOrderId: null });
    await ok('addDiagnosis', { as: 'doctor', params: { id: visit.medicalRecordId }, body: { icd10Code: 'B34.9', kind: 'secondary' } });
    const dup = await fails('addDiagnosis', { as: 'doctor', params: { id: visit.medicalRecordId }, body: { icd10Code: 'J06.9', kind: 'primary' } }, 409);
    expect(dup.sqlstate).toBe('P0409');
    await ok('createLabOrder', { as: 'doctor', body: { patientId: pid, doctorId, medicalRecordId: visit.medicalRecordId, priority: 'routine', testCodes: ['GLU'] } });
    const bad = await fails('createLabOrder', { as: 'doctor', body: { patientId: pid, doctorId, priority: 'routine', testCodes: ['NOPE'] } }, 422);
    expect(bad.sqlstate).toBe('P0050');
  });
});
