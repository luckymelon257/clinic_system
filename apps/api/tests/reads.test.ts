import { describe, expect, it } from 'vitest';
import { day, demoDoctorId, demoPatientId, ok } from './helpers';

// Every read route against seeded data; `ok` parses each body with the contract output schema.
describe('read routes match the contract output schemas', () => {
  it('reference data', async () => {
    expect((await ok('listDepartments', { as: 'admin' })).length).toBeGreaterThan(0);
    expect((await ok('listSpecializations', { as: 'admin' })).length).toBeGreaterThan(0);
    expect((await ok('listInsuranceCompanies', { as: 'admin' })).length).toBeGreaterThan(0);
    expect((await ok('searchIcd10', { as: 'doctor', query: { q: 'j06' } }))[0]?.code).toBe('J06.9');
    expect((await ok('searchMedications', { as: 'doctor', query: { q: '', limit: 5 } })).length).toBe(5);
    expect((await ok('listLabTestTypes', { as: 'lab_technician' })).length).toBeGreaterThan(0);
    expect((await ok('listUsers', { as: 'admin', query: { limit: 3 } })).items).toHaveLength(3);
  });

  it('patients and doctors', async () => {
    const pid = await demoPatientId();
    const did = await demoDoctorId();
    const found = await ok('searchPatients', { as: 'registrar', query: { q: 'Іваненко' } });
    expect(found.some((p) => p.id === pid)).toBe(true);
    const p = await ok('getPatient', { as: 'doctor', params: { id: pid } });
    expect(p.birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.insuranceCoveragePercent).toBeTypeOf('number');
    await ok('patientHistory', { as: 'doctor', params: { id: pid } });
    await ok('patientInsurances', { as: 'cashier', params: { id: pid } });

    const doctors = await ok('listDoctors', { as: 'patient' });
    const d = doctors.find((x) => x.id === did)!;
    expect(d.consultationFee).toBeTypeOf('number');
    expect(await ok('listDoctors', { as: 'patient', query: { departmentId: d.departmentId } })).not.toHaveLength(0);
    expect(await ok('doctorSchedule', { as: 'patient', params: { id: did } })).toHaveLength(7);
    const slots = await ok('freeSlots', { as: 'patient', params: { id: did }, query: { date: day(2) } });
    expect(slots[0]?.slotStart).toMatch(/Z$/);
  });

  it('appointments, records, lab, inpatient, finance, audit', async () => {
    const pid = await demoPatientId();
    const did = await demoDoctorId();
    const page = await ok('listAppointments', { as: 'registrar', query: { doctorId: did, limit: 5 } });
    expect(page.total).toBeGreaterThanOrEqual(page.items.length);
    await ok('listAppointments', { as: 'registrar', query: { date: day(0), status: 'scheduled' } });
    await ok('todayAppointments', { as: 'doctor', query: { doctorId: did } });
    await ok('listMedicalRecords', { as: 'doctor', query: { patientId: pid } });
    await ok('listPrescriptions', { as: 'doctor', query: { patientId: pid } });
    await ok('labQueue', { as: 'lab_technician' });
    await ok('patientLabResults', { as: 'doctor', query: { patientId: pid } });
    await ok('listBeds', { as: 'registrar', query: { status: 'occupied' } });
    await ok('occupancy', { as: 'doctor' });
    await ok('currentAdmissions', { as: 'doctor' });
    const invoices = await ok('listInvoices', { as: 'cashier', query: { limit: 5 } });
    if (invoices.items[0]) await ok('getInvoice', { as: 'cashier', params: { id: invoices.items[0].id } });
    await ok('listInvoices', { as: 'cashier', query: { unpaidOnly: 'true', status: 'issued' } });
    await ok('revenue', { as: 'admin', query: { from: '2020-01-01', to: day(0) } });
    const audit = await ok('auditLog', { as: 'admin', query: { limit: 10 } });
    expect(audit.total).toBeGreaterThan(0);
    await ok('deletedRecords', { as: 'admin' });
  });
});
