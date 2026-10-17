import { http, HttpResponse } from 'msw';
import {
  canAccess,
  routes,
  statusForCode,
  type Appointment,
  type AuditEntry,
  type CurrentUser,
  type ErrorCode,
  type ErrorEnvelope,
  type FieldIssue,
  type HistoryEvent,
  type LabQueueItem,
  type Patient,
  type RouteBody,
  type RouteDef,
  type RouteName,
  type RouteOutput,
  type RouteParams,
  type RouteQuery,
} from '@clinic/contracts';
import type { z } from 'zod';
import {
  activeInsurance,
  addDays,
  at,
  computeRevenue,
  db,
  localDate,
  makeInvoice,
  nextId,
  publicUser,
  recalcInvoice,
  round,
  type PatientRow,
} from './db';

class MockError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly issues?: FieldIssue[],
  ) {
    super(message);
  }
}
const fail = (code: ErrorCode, message: string): never => {
  throw new MockError(code, message);
};

type Ctx<N extends RouteName> = { params: RouteParams<N>; query: RouteQuery<N>; body: RouteBody<N>; user: CurrentUser };
type Impl = { [N in RouteName]: (c: Ctx<N>) => RouteOutput<N> };

const ok = { ok: true as const };
const nowIso = () => new Date().toISOString();
const page = <T,>(all: T[], q: { limit: number; offset: number }) => ({ items: all.slice(q.offset, q.offset + q.limit), total: all.length });
const fullName = (p: { lastName: string; firstName: string; middleName: string | null }) => `${p.lastName} ${p.firstName} ${p.middleName ?? ''}`.trim();
const ageOf = (birth: string) => {
  const b = new Date(birth);
  const n = new Date();
  return n.getFullYear() - b.getFullYear() - (n < new Date(n.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0);
};

const patientRow = (id: number) => db.patients.find((p) => p.id === id && !p.deletedAt) ?? fail('NOT_FOUND', 'Пацієнта не знайдено');
const doctor = (id: number) => db.doctors.find((d) => d.id === id) ?? fail('NOT_FOUND', 'Лікаря не знайдено');
const appointment = (id: number) => db.appointments.find((a) => a.id === id) ?? fail('NOT_FOUND', 'Запис не знайдено');
const invoice = (id: number) => db.invoices.find((i) => i.id === id) ?? fail('NOT_FOUND', 'Рахунок не знайдено');

function patientView(p: PatientRow): Patient {
  const { deletedAt: _, ...rest } = p;
  const ins = activeInsurance(db, p.id);
  return {
    ...rest,
    fullName: fullName(p),
    age: ageOf(p.birthDate),
    insuranceCompanyName: ins?.companyName ?? null,
    insurancePolicyNumber: ins?.policyNumber ?? null,
    insuranceCoveragePercent: ins?.coveragePercent ?? null,
  };
}

function audit(user: CurrentUser, tableName: string, recordId: number, operation: AuditEntry['operation'], oldData: object | null, newData: object | null) {
  const o = oldData as Record<string, unknown> | null;
  const n = newData as Record<string, unknown> | null;
  db.auditLog.unshift({
    id: nextId(db),
    tableName,
    recordId,
    operation,
    changedFields: o && n ? Object.keys(n).filter((k) => JSON.stringify(o[k]) !== JSON.stringify(n[k])) : null,
    oldData: o,
    newData: n,
    changedAt: nowIso(),
    changedBy: user.id,
    changedByEmail: user.email,
  });
}

function createPatient(body: RouteBody<'createPatient'>, user: CurrentUser) {
  const row: PatientRow = { id: nextId(db), ...body, deletedAt: null, createdAt: nowIso(), updatedAt: null, updatedBy: null, updatedByEmail: null };
  db.patients.push(row);
  audit(user, 'patients', row.id, 'INSERT', null, body);
  return row;
}

function addInsurance(patientId: number, body: RouteBody<'addInsurance'>) {
  patientRow(patientId);
  const company = db.insuranceCompanies.find((c) => c.id === body.companyId) ?? fail('BUSINESS_RULE', 'Страхову компанію не знайдено');
  const today = localDate();
  if (db.insurances.some((i) => i.policyNumber === body.policyNumber)) fail('CONFLICT', 'Поліс з таким номером уже існує');
  const ins = {
    id: nextId(db),
    patientId,
    companyName: company.name,
    ...body,
    isActive: body.validFrom <= today && (!body.validTo || body.validTo >= today),
  };
  db.insurances.push(ins);
  return ins;
}

function freeSlots(doctorId: number, date: string) {
  doctor(doctorId);
  const weekday = ((new Date(`${date}T12:00:00`).getDay() + 6) % 7) + 1;
  const busy = db.appointments.filter((a) => a.doctorId === doctorId && a.status !== 'cancelled');
  const now = Date.now();
  const slots: { slotStart: string; slotEnd: string }[] = [];
  for (const s of db.schedules.filter((x) => x.doctorId === doctorId && x.weekday === weekday)) {
    const end = new Date(at(date, s.endTime)).getTime();
    for (let t = new Date(at(date, s.startTime)).getTime(); t + s.slotMinutes * 60000 <= end; t += s.slotMinutes * 60000) {
      const tEnd = t + s.slotMinutes * 60000;
      const taken = busy.some((a) => new Date(a.startsAt).getTime() < tEnd && new Date(a.endsAt).getTime() > t);
      if (!taken && t > now) slots.push({ slotStart: new Date(t).toISOString(), slotEnd: new Date(tEnd).toISOString() });
    }
  }
  return slots;
}

function book(body: { patientId: number; doctorId: number; startsAt: string; reason: string | null }, user: CurrentUser): Appointment {
  const p = patientRow(body.patientId);
  const dr = doctor(body.doctorId);
  const start = new Date(body.startsAt).getTime();
  const end = start + 30 * 60000;
  const overlaps = db.appointments.some(
    (a) => a.doctorId === dr.id && a.status !== 'cancelled' && new Date(a.startsAt).getTime() < end && new Date(a.endsAt).getTime() > start,
  );
  if (overlaps) fail('CONFLICT', 'Лікар уже має запис на цей час');
  if (!freeSlots(dr.id, localDate(new Date(start))).some((s) => new Date(s.slotStart).getTime() === start))
    fail('BUSINESS_RULE', 'Час поза розкладом лікаря');
  const a: Appointment = {
    id: nextId(db),
    patientId: p.id,
    patientName: fullName(p),
    doctorId: dr.id,
    doctorName: dr.fullName,
    departmentName: dr.departmentName,
    specializationName: dr.specializationName,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    status: 'scheduled',
    reason: body.reason,
    cancelReason: null,
    room: db.schedules.find((s) => s.doctorId === dr.id)?.room ?? null,
    medicalRecordId: null,
    createdAt: nowIso(),
    updatedAt: null,
    updatedBy: null,
    updatedByEmail: null,
  };
  db.appointments.push(a);
  audit(user, 'appointments', a.id, 'INSERT', null, { patient_id: a.patientId, doctor_id: a.doctorId, starts_at: a.startsAt, status: a.status });
  return a;
}

function touch(a: Appointment, user: CurrentUser) {
  Object.assign(a, { updatedAt: nowIso(), updatedBy: user.id, updatedByEmail: user.email });
}

function testType(code: string) {
  return db.labTestTypes.find((t) => t.code === code) ?? fail('BUSINESS_RULE', `Невідомий тип аналізу: ${code}`);
}

function createLabOrder(b: { patientId: number; doctorId: number; medicalRecordId: number | null; priority: 'routine' | 'urgent'; testCodes: string[] }) {
  const order = { id: nextId(db), ...b, status: 'ordered' as const, orderedAt: nowIso(), testTypeIds: b.testCodes.map((c) => testType(c).id) };
  db.labOrders.push(order);
  return order;
}

function history(patientId: number): HistoryEvent[] {
  const ev: HistoryEvent[] = [];
  for (const a of db.appointments.filter((x) => x.patientId === patientId))
    ev.push({ eventAt: a.startsAt, eventType: 'appointment', description: `Прийом: ${a.specializationName} (${a.status})${a.reason ? ` — ${a.reason}` : ''}`, doctor: a.doctorName, refId: a.id });
  for (const r of db.records.filter((x) => x.patientId === patientId))
    for (const d of r.diagnoses)
      ev.push({ eventAt: r.createdAt, eventType: 'diagnosis', description: `${d.icd10Code} ${d.icd10Title} (${d.kind === 'primary' ? 'основний' : 'супутній'})`, doctor: r.doctorName, refId: r.id });
  for (const p of db.prescriptions.filter((x) => x.patientId === patientId))
    ev.push({ eventAt: p.issuedAt, eventType: 'prescription', description: `Рецепт: ${p.items.map((i) => i.medicationName).join(', ')}`, doctor: p.doctorName, refId: p.id });
  for (const o of db.labOrders.filter((x) => x.patientId === patientId))
    ev.push({
      eventAt: o.orderedAt,
      eventType: 'lab_order',
      description: `Направлення на аналізи: ${o.testTypeIds.map((id) => db.labTestTypes.find((t) => t.id === id)?.name).join(', ')}`,
      doctor: db.doctors.find((d) => d.id === o.doctorId)?.fullName ?? null,
      refId: o.id,
    });
  for (const r of db.labResults.filter((x) => x.patientId === patientId))
    ev.push({ eventAt: r.recordedAt, eventType: 'lab_result', description: `${r.testName}: ${r.valueNumeric ?? r.valueText} ${r.unit ?? ''}${r.isAbnormal ? ' (поза нормою)' : ''}`, doctor: null, refId: r.orderId });
  for (const a of db.admissions.filter((x) => x.patientId === patientId)) {
    ev.push({ eventAt: a.admittedAt, eventType: 'admission', description: `Госпіталізація: ${a.departmentName}, палата ${a.wardNumber}`, doctor: a.doctorName, refId: a.id });
    if (a.dischargedAt) ev.push({ eventAt: a.dischargedAt, eventType: 'discharge', description: `Виписка: ${a.dischargeSummary ?? ''}`, doctor: a.doctorName, refId: a.id });
  }
  return ev.sort((x, y) => y.eventAt.localeCompare(x.eventAt));
}

function labQueue(): LabQueueItem[] {
  const items: LabQueueItem[] = [];
  for (const o of db.labOrders.filter((x) => x.status === 'ordered' || x.status === 'in_progress'))
    for (const tid of o.testTypeIds) {
      if (db.labResults.some((r) => r.orderId === o.id && r.testTypeId === tid)) continue;
      const t = db.labTestTypes.find((x) => x.id === tid)!;
      items.push({
        orderId: o.id,
        patientId: o.patientId,
        patientName: fullName(db.patients.find((p) => p.id === o.patientId)!),
        doctorName: db.doctors.find((d) => d.id === o.doctorId)!.fullName,
        priority: o.priority,
        status: o.status,
        orderedAt: o.orderedAt,
        testTypeId: t.id,
        testCode: t.code,
        testName: t.name,
        unit: t.unit,
        refMin: t.refMin,
        refMax: t.refMax,
      });
    }
  return items.sort((a, b) => (a.priority === b.priority ? a.orderedAt.localeCompare(b.orderedAt) : a.priority === 'urgent' ? -1 : 1));
}

function syncBed(bedId: number, admission: { id: number; patientId: number; patientName: string } | null) {
  const bed = db.beds.find((b) => b.id === bedId)!;
  Object.assign(bed, admission ? { status: 'occupied', admissionId: admission.id, patientId: admission.patientId, patientName: admission.patientName } : { status: 'available', admissionId: null, patientId: null, patientName: null });
}

const impl: Impl = {
  // ---------- auth / users ----------
  login: ({ body }) => {
    const u = db.users.find((x) => x.email === body.email);
    if (!u || u.password !== body.password) return fail('UNAUTHENTICATED', 'Невірний email або пароль');
    if (!u.isActive) return fail('UNAUTHENTICATED', 'Обліковий запис деактивовано');
    u.lastLoginAt = nowIso();
    return { token: `mock-token-${u.id}`, user: publicUser(u) };
  },
  me: ({ user }) => user,
  listUsers: ({ query }) => page(db.users.map(({ password: _, doctorId: _d, patientId: _p, ...rest }) => rest), query),
  createUser: ({ body, user }) => {
    if (db.users.some((u) => u.email === body.email)) fail('CONFLICT', 'Користувач з таким email уже існує');
    const id = nextId(db);
    db.users.push({ id, ...body, isActive: true, lastLoginAt: null, doctorId: null, patientId: null, createdAt: nowIso(), updatedAt: null, updatedBy: null, updatedByEmail: null });
    audit(user, 'users', id, 'INSERT', null, { email: body.email, role: body.role });
    return { id };
  },
  setUserActive: ({ params, body, user }) => {
    const u = db.users.find((x) => x.id === params.id) ?? fail('NOT_FOUND', 'Користувача не знайдено');
    audit(user, 'users', u.id, 'UPDATE', { is_active: u.isActive }, { is_active: body.isActive });
    u.isActive = body.isActive;
    return ok;
  },

  // ---------- reference ----------
  listDepartments: () => db.departments,
  listSpecializations: () => db.specializations,
  listInsuranceCompanies: () => db.insuranceCompanies,
  searchIcd10: ({ query }) => db.icd10.filter((c) => `${c.code} ${c.title}`.toLowerCase().includes(query.q.toLowerCase())).slice(0, query.limit),
  searchMedications: ({ query }) => db.medications.filter((m) => m.name.toLowerCase().includes(query.q.toLowerCase())).slice(0, query.limit),
  listLabTestTypes: () => db.labTestTypes,

  // ---------- patients ----------
  searchPatients: ({ query }) => {
    const q = query.q.toLowerCase();
    const digits = q.replace(/\D/g, '');
    return db.patients
      .filter((p) => !p.deletedAt)
      .filter((p) => !q || fullName(p).toLowerCase().includes(q) || (digits.length >= 3 && (p.phone ?? '').replace(/\D/g, '').includes(digits)))
      .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
      .slice(0, query.limit)
      .map(patientView);
  },
  getPatient: ({ params }) => patientView(patientRow(params.id)),
  createPatient: ({ body, user }) => ({ id: createPatient(body, user).id }),
  updatePatient: ({ params, body, user }) => {
    const p = patientRow(params.id);
    const { deletedAt: _, createdAt: _c, updatedAt: _u, updatedBy: _b, updatedByEmail: _e, id: _i, ...old } = p;
    Object.assign(p, body, { updatedAt: nowIso(), updatedBy: user.id, updatedByEmail: user.email });
    audit(user, 'patients', p.id, 'UPDATE', old, body);
    return patientView(p);
  },
  deletePatient: ({ params, user }) => {
    const p = patientRow(params.id);
    p.deletedAt = nowIso();
    db.deleted.unshift({ tableName: 'patients', recordId: p.id, label: fullName(p), deletedAt: p.deletedAt, deletedBy: user.id, deletedByEmail: user.email });
    audit(user, 'patients', p.id, 'SOFT_DELETE', { deleted_at: null }, { deleted_at: p.deletedAt });
    return ok;
  },
  patientHistory: ({ params }) => (patientRow(params.id), history(params.id)),
  patientInsurances: ({ params }) => db.insurances.filter((i) => i.patientId === patientRow(params.id).id),
  addInsurance: ({ params, body }) => ({ id: addInsurance(params.id, body).id }),
  register: ({ body, user }) => {
    // one "UoW": validate everything that can fail before writing
    if (body.appointment) {
      doctor(body.appointment.doctorId);
      const start = new Date(body.appointment.startsAt).getTime();
      if (!freeSlots(body.appointment.doctorId, localDate(new Date(start))).some((s) => new Date(s.slotStart).getTime() === start))
        fail('CONFLICT', 'Обраний час уже зайнятий або поза розкладом');
    }
    const p = createPatient(body.patient, user);
    const ins = body.insurance ? addInsurance(p.id, body.insurance) : null;
    const a = body.appointment ? book({ ...body.appointment, patientId: p.id }, user) : null;
    return { patientId: p.id, insuranceId: ins?.id ?? null, appointmentId: a?.id ?? null };
  },

  // ---------- doctors ----------
  listDoctors: ({ query }) =>
    db.doctors.filter((d) => (!query.departmentId || d.departmentId === query.departmentId) && (!query.specializationId || d.specializationId === query.specializationId)),
  getDoctor: ({ params }) => doctor(params.id),
  doctorSchedule: ({ params }) => db.schedules.filter((s) => s.doctorId === doctor(params.id).id),
  freeSlots: ({ params, query }) => freeSlots(params.id, query.date),

  // ---------- appointments ----------
  listAppointments: ({ query }) =>
    page(
      db.appointments
        .filter(
          (a) =>
            (!query.doctorId || a.doctorId === query.doctorId) &&
            (!query.patientId || a.patientId === query.patientId) &&
            (!query.status || a.status === query.status) &&
            (!query.date || localDate(new Date(a.startsAt)) === query.date),
        )
        .sort((a, b) => b.startsAt.localeCompare(a.startsAt)),
      query,
    ),
  todayAppointments: ({ query }) =>
    db.appointments
      .filter(
        (a) =>
          localDate(new Date(a.startsAt)) === localDate() &&
          (!query.doctorId || a.doctorId === query.doctorId) &&
          (!query.departmentId || doctor(a.doctorId).departmentId === query.departmentId),
      )
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
  getAppointment: ({ params }) => appointment(params.id),
  bookAppointment: ({ body, user }) => ({ id: book(body, user).id }),
  rescheduleAppointment: ({ params, body, user }) => {
    const a = appointment(params.id);
    const start = new Date(body.startsAt).getTime();
    if (!freeSlots(a.doctorId, localDate(new Date(start))).some((s) => new Date(s.slotStart).getTime() === start)) fail('CONFLICT', 'Обраний час недоступний');
    a.startsAt = new Date(start).toISOString();
    a.endsAt = new Date(start + 30 * 60000).toISOString();
    touch(a, user);
    return ok;
  },
  setAppointmentStatus: ({ params, body, user }) => {
    const a = appointment(params.id);
    if (a.status === 'completed' || a.status === 'cancelled') fail('BUSINESS_RULE', 'Статус завершеного або скасованого запису змінити не можна');
    if (body.status === 'completed') fail('BUSINESS_RULE', 'Завершити прийом можна лише через екран прийому');
    audit(user, 'appointments', a.id, 'UPDATE', { status: a.status }, { status: body.status });
    a.status = body.status;
    touch(a, user);
    return ok;
  },
  cancelAppointment: ({ params, body, user }) => {
    const a = appointment(params.id);
    if (a.status === 'completed') fail('BUSINESS_RULE', 'Завершений прийом скасувати не можна');
    Object.assign(a, { status: 'cancelled', cancelReason: body.reason });
    touch(a, user);
    return ok;
  },

  // ---------- visit ----------
  completeVisit: ({ params, body, user }) => {
    const a = appointment(params.id);
    if (a.status === 'completed' || a.status === 'cancelled' || a.status === 'no_show') fail('BUSINESS_RULE', 'Прийом уже завершено або скасовано');
    if (user.role === 'doctor' && user.doctorId !== a.doctorId) fail('FORBIDDEN', 'Це не ваш пацієнт');
    const diagnoses = body.diagnoses.map((d) => {
      const code = db.icd10.find((c) => c.code === d.icd10Code) ?? fail('BUSINESS_RULE', `Невідомий код МКХ-10: ${d.icd10Code}`);
      return { ...d, icd10Title: code.title };
    });
    const meds = (body.prescription?.items ?? []).map((i) => ({ ...i, med: db.medications.find((m) => m.id === i.medicationId) ?? fail('BUSINESS_RULE', 'Препарат не знайдено') }));
    body.labOrder?.testCodes.forEach(testType);

    const recordId = nextId(db);
    const dx = diagnoses.map((d) => ({ id: nextId(db), medicalRecordId: recordId, icd10Code: d.icd10Code, icd10Title: d.icd10Title, kind: d.kind, notes: d.notes }));
    db.records.push({
      id: recordId,
      patientId: a.patientId,
      patientName: a.patientName,
      doctorId: a.doctorId,
      doctorName: a.doctorName,
      appointmentId: a.id,
      admissionId: null,
      complaints: body.complaints,
      examination: body.examination,
      conclusion: body.conclusion,
      recommendations: body.recommendations,
      diagnosesSummary: dx.map((d) => `${d.icd10Code} ${d.icd10Title}`).join('; '),
      diagnoses: dx,
      createdAt: nowIso(),
    });
    let prescriptionId: number | null = null;
    if (body.prescription) {
      prescriptionId = nextId(db);
      db.prescriptions.push({
        id: prescriptionId,
        medicalRecordId: recordId,
        patientId: a.patientId,
        patientName: a.patientName,
        doctorName: a.doctorName,
        issuedAt: nowIso(),
        validUntil: body.prescription.validUntil,
        items: meds.map(({ med, ...i }) => ({ ...i, medicationName: `${med.name} ${med.strength ?? ''}`.trim() })),
      });
    }
    const order = body.labOrder ? createLabOrder({ patientId: a.patientId, doctorId: a.doctorId, medicalRecordId: recordId, ...body.labOrder }) : null;
    const fee = doctor(a.doctorId).consultationFee;
    const inv = makeInvoice(db, a.patientId, [{ itemType: 'consultation', description: `Консультація: ${a.specializationName}`, quantity: 1, unitPrice: fee }], { appointmentId: a.id });
    Object.assign(a, { status: 'completed', medicalRecordId: recordId });
    touch(a, user);
    return { medicalRecordId: recordId, diagnosisIds: dx.map((d) => d.id), prescriptionId, labOrderId: order?.id ?? null, invoiceId: inv.id };
  },
  listMedicalRecords: ({ query }) => page(db.records.filter((r) => r.patientId === query.patientId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), query),
  getMedicalRecord: ({ params }) => db.records.find((r) => r.id === params.id) ?? fail('NOT_FOUND', 'Медичний запис не знайдено'),
  addDiagnosis: ({ params, body }) => {
    const r = db.records.find((x) => x.id === params.id) ?? fail('NOT_FOUND', 'Медичний запис не знайдено');
    const code = db.icd10.find((c) => c.code === body.icd10Code) ?? fail('BUSINESS_RULE', `Невідомий код МКХ-10: ${body.icd10Code}`);
    if (body.kind === 'primary' && r.diagnoses.some((d) => d.kind === 'primary')) fail('CONFLICT', 'Основний діагноз уже встановлено');
    const id = nextId(db);
    r.diagnoses.push({ id, medicalRecordId: r.id, icd10Code: code.code, icd10Title: code.title, kind: body.kind, notes: body.notes });
    return { id };
  },
  listPrescriptions: ({ query }) => db.prescriptions.filter((p) => p.patientId === query.patientId),

  // ---------- lab ----------
  labQueue: ({ query }) => labQueue().filter((i) => !query.priority || i.priority === query.priority),
  createLabOrder: ({ body }) => (patientRow(body.patientId), doctor(body.doctorId), { id: createLabOrder(body).id }),
  labOrderResults: ({ params }) => db.labResults.filter((r) => r.orderId === params.id),
  recordLabResult: ({ params, body, user }) => {
    const order = db.labOrders.find((o) => o.id === params.id) ?? fail('NOT_FOUND', 'Направлення не знайдено');
    if (!order.testTypeIds.includes(body.testTypeId)) fail('BUSINESS_RULE', 'Цей аналіз не входить до направлення');
    if (db.labResults.some((r) => r.orderId === order.id && r.testTypeId === body.testTypeId)) fail('CONFLICT', 'Результат цього аналізу вже внесено');
    const t = db.labTestTypes.find((x) => x.id === body.testTypeId)!;
    const v = body.valueNumeric;
    const result = {
      id: nextId(db),
      orderId: order.id,
      patientId: order.patientId,
      patientName: fullName(db.patients.find((p) => p.id === order.patientId)!),
      testTypeId: t.id,
      testCode: t.code,
      testName: t.name,
      valueNumeric: v,
      valueText: body.valueText,
      unit: t.unit,
      refMin: t.refMin,
      refMax: t.refMax,
      isAbnormal: v === null || (t.refMin === null && t.refMax === null) ? null : (t.refMin !== null && v < t.refMin) || (t.refMax !== null && v > t.refMax),
      recordedAt: nowIso(),
      recordedByEmail: user.email,
    };
    db.labResults.push(result);
    order.status = order.testTypeIds.every((id) => db.labResults.some((r) => r.orderId === order.id && r.testTypeId === id)) ? 'completed' : 'in_progress';
    return result;
  },
  patientLabResults: ({ query }) => db.labResults.filter((r) => r.patientId === query.patientId),

  // ---------- inpatient ----------
  listBeds: ({ query }) => db.beds.filter((b) => (!query.departmentId || b.departmentId === query.departmentId) && (!query.status || b.status === query.status)),
  occupancy: () =>
    db.departments.flatMap((dep) => {
      const beds = db.beds.filter((b) => b.departmentId === dep.id);
      if (!beds.length) return [];
      const row = (wardId: number | null, wardNumber: string | null, list: typeof beds) => {
        const occupiedBeds = list.filter((b) => b.status === 'occupied').length;
        return { departmentId: dep.id, departmentName: dep.name, wardId, wardNumber, totalBeds: list.length, occupiedBeds, occupancyPercent: round((occupiedBeds * 100) / list.length) };
      };
      const wards = [...new Set(beds.map((b) => b.wardId))];
      return [...wards.map((w) => row(w, beds.find((b) => b.wardId === w)!.wardNumber, beds.filter((b) => b.wardId === w))), row(null, null, beds)];
    }),
  currentAdmissions: () => db.admissions.filter((a) => a.status === 'active'),
  admit: ({ body }) => {
    const p = patientRow(body.patientId);
    const dr = doctor(body.doctorId);
    const bed = db.beds.find((b) => b.id === body.bedId) ?? fail('NOT_FOUND', 'Ліжко не знайдено');
    if (bed.status !== 'available') fail('CONFLICT', 'Ліжко вже зайняте або на обслуговуванні');
    if (db.admissions.some((a) => a.patientId === p.id && a.status === 'active')) fail('BUSINESS_RULE', 'Пацієнт уже перебуває у стаціонарі');
    const a = {
      id: nextId(db),
      patientId: p.id,
      patientName: fullName(p),
      bedId: bed.id,
      bedNumber: bed.bedNumber,
      wardNumber: bed.wardNumber,
      departmentName: bed.departmentName,
      doctorId: dr.id,
      doctorName: dr.fullName,
      admittedAt: nowIso(),
      dischargedAt: null,
      reason: body.reason,
      dischargeSummary: null,
      status: 'active' as const,
      days: 0,
    };
    db.admissions.push(a);
    syncBed(bed.id, a);
    return { id: a.id };
  },
  transfer: ({ params, body }) => {
    const a = db.admissions.find((x) => x.id === params.id && x.status === 'active') ?? fail('NOT_FOUND', 'Активну госпіталізацію не знайдено');
    const bed = db.beds.find((b) => b.id === body.bedId) ?? fail('NOT_FOUND', 'Ліжко не знайдено');
    if (bed.status !== 'available') fail('CONFLICT', 'Ліжко вже зайняте або на обслуговуванні');
    syncBed(a.bedId, null);
    Object.assign(a, { bedId: bed.id, bedNumber: bed.bedNumber, wardNumber: bed.wardNumber, departmentName: bed.departmentName });
    syncBed(bed.id, a);
    return ok;
  },
  discharge: ({ params, body }) => {
    const a = db.admissions.find((x) => x.id === params.id && x.status === 'active') ?? fail('NOT_FOUND', 'Активну госпіталізацію не знайдено');
    const bed = db.beds.find((b) => b.id === a.bedId)!;
    const days = Math.max(1, Math.ceil((Date.now() - new Date(a.admittedAt).getTime()) / 86400000));
    Object.assign(a, { status: 'discharged', dischargedAt: nowIso(), dischargeSummary: body.summary, days });
    syncBed(bed.id, null);
    const inv = makeInvoice(db, a.patientId, [{ itemType: 'stay', description: `Перебування у стаціонарі (палата ${a.wardNumber})`, quantity: days, unitPrice: bed.dailyRate }], { admissionId: a.id });
    return { admissionId: a.id, invoiceId: inv.id };
  },

  // ---------- finance ----------
  listInvoices: ({ query }) => {
    db.invoices.forEach(recalcInvoice);
    return page(
      db.invoices
        .filter(
          (i) =>
            (!query.patientId || i.patientId === query.patientId) &&
            (!query.status || i.status === query.status) &&
            (!query.unpaidOnly || ((i.status === 'issued' || i.status === 'partially_paid') && i.balance > 0)),
        )
        .map(({ items: _, payments: _p, ...rest }) => rest)
        .sort((a, b) => b.id - a.id),
      query,
    );
  },
  getInvoice: ({ params }) => invoice(params.id),
  createInvoice: ({ body }) => {
    patientRow(body.patientId);
    const inv = makeInvoice(db, body.patientId, [], { appointmentId: body.appointmentId ?? undefined, admissionId: body.admissionId ?? undefined });
    Object.assign(inv, { status: 'draft', issuedAt: null, dueDate: null });
    return { id: inv.id };
  },
  addInvoiceItem: ({ params, body }) => {
    const inv = invoice(params.id);
    if (inv.status !== 'draft') fail('BUSINESS_RULE', 'Позиції можна додавати лише до чернетки');
    const id = nextId(db);
    inv.items.push({ id, invoiceId: inv.id, ...body, amount: round(body.quantity * body.unitPrice) });
    recalcInvoice(inv);
    return { id };
  },
  issueInvoice: ({ params, body }) => {
    const inv = invoice(params.id);
    if (inv.status !== 'draft') fail('BUSINESS_RULE', 'Виставити можна лише чернетку');
    if (!inv.items.length) fail('BUSINESS_RULE', 'Рахунок без позицій');
    Object.assign(inv, { status: 'issued', issuedAt: nowIso(), dueDate: addDays(localDate(), body.dueDays) });
    recalcInvoice(inv);
    return ok;
  },
  registerPayment: ({ params, body, user }) => {
    const inv = invoice(params.id);
    if (inv.status === 'draft' || inv.status === 'cancelled') fail('BUSINESS_RULE', 'Рахунок не виставлено або скасовано');
    if (body.amount > inv.balance + 1e-9) fail('BUSINESS_RULE', `Сума оплат перевищує суму до сплати (залишок ${inv.balance.toFixed(2)} грн)`);
    const id = nextId(db);
    inv.payments.push({ id, invoiceId: inv.id, ...body, paidAt: nowIso(), receivedByEmail: user.email });
    recalcInvoice(inv);
    audit(user, 'payments', id, 'INSERT', null, { invoice_id: inv.id, amount: body.amount, method: body.method });
    return { id };
  },
  revenue: ({ query }) => db.revenue.filter((r) => (!query.from || r.month >= query.from) && (!query.to || r.month <= query.to)),
  refreshReports: () => {
    db.revenue = computeRevenue(db);
    return ok;
  },

  // ---------- audit / admin ----------
  auditLog: ({ query }) =>
    page(
      db.auditLog.filter(
        (e) =>
          (!query.tableName || e.tableName === query.tableName) &&
          (!query.recordId || e.recordId === query.recordId) &&
          (!query.changedBy || e.changedBy === query.changedBy) &&
          (!query.operation || e.operation === query.operation),
      ),
      query,
    ),
  deletedRecords: ({ query }) => db.deleted.filter((d) => !query.tableName || d.tableName === query.tableName),
  softDelete: ({ params, user }) => {
    if (db.deleted.some((d) => d.tableName === params.table && d.recordId === params.id)) fail('CONFLICT', 'Запис уже видалено');
    const p = params.table === 'patients' ? patientRow(params.id) : null;
    if (p) p.deletedAt = nowIso();
    db.deleted.unshift({ tableName: params.table, recordId: params.id, label: p ? fullName(p) : `${params.table} #${params.id}`, deletedAt: nowIso(), deletedBy: user.id, deletedByEmail: user.email });
    audit(user, params.table, params.id, 'SOFT_DELETE', { deleted_at: null }, { deleted_at: nowIso() });
    return ok;
  },
  restore: ({ params, user }) => {
    const i = db.deleted.findIndex((d) => d.tableName === params.table && d.recordId === params.id);
    if (i < 0) fail('NOT_FOUND', 'Видалений запис не знайдено');
    db.deleted.splice(i, 1);
    const p = params.table === 'patients' ? db.patients.find((x) => x.id === params.id) : null;
    if (p) p.deletedAt = null;
    audit(user, params.table, params.id, 'RESTORE', { deleted_at: 'set' }, { deleted_at: null });
    return ok;
  },
};

function parse(schema: z.ZodType | undefined, value: unknown) {
  if (!schema) return undefined;
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new MockError(
    'VALIDATION_ERROR',
    'Помилка валідації',
    r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
}

const userFromToken = (header: string | null) => {
  const id = Number(header?.match(/^Bearer mock-token-(\d+)$/)?.[1]);
  const u = db.users.find((x) => x.id === id && x.isActive);
  return u ? publicUser(u) : null;
};

/** One MSW handler per contract route ('*' prefix: matches any origin, so VITE_API_URL may be set). */
export const handlers = (Object.keys(routes) as RouteName[]).map((name) => {
  const route: RouteDef = routes[name];
  const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  return http[method](`*${route.path}`, async ({ request, params }) => {
    try {
      const user = userFromToken(request.headers.get('Authorization'));
      if (route.roles !== 'public' && !user) fail('UNAUTHENTICATED', 'Потрібно увійти в систему');
      if (!canAccess(route, user?.role ?? null)) fail('FORBIDDEN', 'Недостатньо прав');
      const ctx = {
        params: parse(route.params, params),
        query: parse(route.query, Object.fromEntries(new URL(request.url).searchParams)),
        body: parse(route.body, route.body ? await request.json().catch(() => undefined) : undefined),
        user,
      };
      const out = (impl[name] as (c: typeof ctx) => unknown)(ctx);
      route.output.parse(out); // mocks must stay contract-shaped; drift fails loudly in tests and dev
      return HttpResponse.json(out as object, { status: route.status ?? 200 });
    } catch (e) {
      if (!(e instanceof MockError)) throw e;
      const body: ErrorEnvelope = { error: { code: e.code, message: e.message, ...(e.issues && { issues: e.issues }) } };
      return HttpResponse.json(body, { status: statusForCode[e.code] });
    }
  });
});
