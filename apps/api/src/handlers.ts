import type { CurrentUser, RouteBody, RouteName, RouteOutput, RouteParams, RouteQuery } from '@clinic/contracts';
import bcrypt from 'bcryptjs';
import { signToken } from './auth';
import { reads, UnitOfWork } from './db/UnitOfWork';
import { HttpError, notFound } from './errors';
import { InpatientService } from './services/InpatientService';
import { RegistrationService } from './services/RegistrationService';
import { VisitService } from './services/VisitService';

export type Ctx<N extends RouteName> = {
  params: RouteParams<N>;
  query: RouteQuery<N>;
  body: RouteBody<N>;
  user: CurrentUser; // guaranteed by authenticate() for every non-public route (only `login` is public)
};
type Handlers = { [N in RouteName]: (ctx: Ctx<N>) => Promise<RouteOutput<N>> };

const ok = { ok: true as const };
async function found<T>(p: Promise<T | null>, what?: string): Promise<T> {
  const row = await p;
  if (row === null) throw notFound(what);
  return row;
}

// Reads use `reads` (pool). Every write goes through UnitOfWork.run(user.id, …).
export const handlers: Handlers = {
  // ---------- auth / users ----------
  async login({ body }) {
    const u = await reads.users.authByEmail(body.email);
    if (!u || !(await bcrypt.compare(body.password, u.passwordHash))) throw new HttpError('UNAUTHENTICATED', 'Невірний email або пароль');
    if (!u.isActive) throw new HttpError('UNAUTHENTICATED', 'Обліковий запис деактивовано');
    await UnitOfWork.run(u.id, (uow) => uow.users.touchLogin(u.id));
    const user = { id: u.id, email: u.email, role: u.role, fullName: u.fullName, doctorId: u.doctorId, patientId: u.patientId };
    return { token: signToken(user), user };
  },
  me: async ({ user }) => user,
  listUsers: ({ query }) => reads.users.list(query),
  async createUser({ body, user }) {
    const hash = await bcrypt.hash(body.password, 10);
    return { id: await UnitOfWork.run(user.id, (uow) => uow.users.create(body.email, hash, body.role, body.fullName)) };
  },
  async setUserActive({ params, body, user }) {
    await UnitOfWork.run(user.id, (uow) => uow.users.setActive(params.id, body.isActive));
    return ok;
  },

  // ---------- reference ----------
  listDepartments: () => reads.reference.departments(),
  listSpecializations: () => reads.reference.specializations(),
  listInsuranceCompanies: () => reads.reference.insuranceCompanies(),
  searchIcd10: ({ query }) => reads.reference.icd10(query),
  searchMedications: ({ query }) => reads.reference.medications(query),
  listLabTestTypes: () => reads.reference.labTestTypes(),

  // ---------- patients ----------
  searchPatients: ({ query }) => reads.patients.search(query),
  getPatient: ({ params }) => found(reads.patients.findById(params.id), 'Пацієнта не знайдено'),
  createPatient: async ({ body, user }) => ({ id: await UnitOfWork.run(user.id, (uow) => uow.patients.create(body)) }),
  updatePatient: ({ params, body, user }) =>
    UnitOfWork.run(user.id, async (uow) => {
      await uow.patients.update(params.id, body);
      return found(uow.patients.findById(params.id), 'Пацієнта не знайдено');
    }),
  async deletePatient({ params, user }) {
    await UnitOfWork.run(user.id, (uow) => uow.audit.softDelete('patients', params.id));
    return ok;
  },
  patientHistory: ({ params }) => reads.patients.history(params.id),
  patientInsurances: ({ params }) => reads.patients.insurances(params.id),
  addInsurance: async ({ params, body, user }) => ({
    id: await UnitOfWork.run(user.id, (uow) => uow.patients.addInsurance(params.id, body)),
  }),
  register: ({ body, user }) => RegistrationService.register(user.id, body),

  // ---------- doctors ----------
  listDoctors: ({ query }) => reads.doctors.list(query),
  getDoctor: ({ params }) => found(reads.doctors.findById(params.id), 'Лікаря не знайдено'),
  doctorSchedule: ({ params }) => reads.doctors.schedule(params.id),
  freeSlots: ({ params, query }) => reads.doctors.freeSlots(params.id, query.date),

  // ---------- appointments ----------
  listAppointments: ({ query }) => reads.appointments.list(query),
  todayAppointments: ({ query }) => reads.appointments.today(query),
  getAppointment: ({ params }) => found(reads.appointments.findById(params.id), 'Запис на прийом не знайдено'),
  bookAppointment: async ({ body, user }) => ({
    id: await UnitOfWork.run(user.id, (uow) => uow.appointments.book(body.patientId, body.doctorId, body.startsAt, body.reason)),
  }),
  async rescheduleAppointment({ params, body, user }) {
    await UnitOfWork.run(user.id, (uow) => uow.appointments.reschedule(params.id, body.startsAt));
    return ok;
  },
  async setAppointmentStatus({ params, body, user }) {
    await UnitOfWork.run(user.id, (uow) => uow.appointments.setStatus(params.id, body.status));
    return ok;
  },
  async cancelAppointment({ params, body, user }) {
    await UnitOfWork.run(user.id, (uow) => uow.appointments.cancel(params.id, body.reason));
    return ok;
  },

  // ---------- visit / medical records ----------
  completeVisit: ({ params, body, user }) => VisitService.complete(user.id, params.id, body),
  listMedicalRecords: ({ query }) => reads.medicalRecords.list(query),
  getMedicalRecord: ({ params }) => found(reads.medicalRecords.findById(params.id), 'Медичний запис не знайдено'),
  addDiagnosis: async ({ params, body, user }) => ({
    id: await UnitOfWork.run(user.id, (uow) => uow.medicalRecords.addDiagnosis(params.id, body)),
  }),
  listPrescriptions: ({ query }) => reads.prescriptions.listByPatient(query.patientId),

  // ---------- lab ----------
  labQueue: ({ query }) => reads.labOrders.queue(query),
  createLabOrder: async ({ body, user }) => ({ id: await UnitOfWork.run(user.id, (uow) => uow.labOrders.create(body)) }),
  labOrderResults: ({ params }) => reads.labOrders.resultsByOrder(params.id),
  recordLabResult: ({ params, body, user }) =>
    UnitOfWork.run(user.id, async (uow) => found(uow.labOrders.findResult(await uow.labOrders.recordResult(params.id, body)))),
  patientLabResults: ({ query }) => reads.labOrders.resultsByPatient(query.patientId),

  // ---------- inpatient ----------
  listBeds: ({ query }) => reads.admissions.beds(query),
  occupancy: () => reads.admissions.occupancy(),
  currentAdmissions: () => reads.admissions.current(),
  admit: async ({ body, user }) => ({ id: await InpatientService.admit(user.id, body) }),
  async transfer({ params, body, user }) {
    await InpatientService.transfer(user.id, params.id, body.bedId);
    return ok;
  },
  discharge: ({ params, body, user }) => InpatientService.discharge(user.id, params.id, body.summary),

  // ---------- finance ----------
  listInvoices: ({ query }) => reads.invoices.list(query),
  async getInvoice({ params }) {
    const invoice = await found(reads.invoices.findById(params.id), 'Рахунок не знайдено');
    const [items, payments] = await Promise.all([reads.invoices.items(params.id), reads.invoices.payments(params.id)]);
    return { ...invoice, items, payments };
  },
  createInvoice: async ({ body, user }) => ({
    id: await UnitOfWork.run(user.id, (uow) => uow.invoices.create(body.patientId, body.appointmentId, body.admissionId)),
  }),
  addInvoiceItem: async ({ params, body, user }) => ({
    id: await UnitOfWork.run(user.id, (uow) => uow.invoices.addItem(params.id, body)),
  }),
  async issueInvoice({ params, body, user }) {
    await UnitOfWork.run(user.id, (uow) => uow.invoices.issue(params.id, body.dueDays));
    return ok;
  },
  registerPayment: async ({ params, body, user }) => ({
    id: await UnitOfWork.run(user.id, (uow) => uow.invoices.registerPayment(params.id, body)),
  }),
  revenue: ({ query }) => reads.invoices.revenue(query),
  async refreshReports({ user }) {
    await UnitOfWork.run(user.id, (uow) => uow.invoices.refreshReports());
    return ok;
  },

  // ---------- audit / admin ----------
  auditLog: ({ query }) => reads.audit.list(query),
  deletedRecords: ({ query }) => reads.audit.deleted(query),
  async softDelete({ params, user }) {
    await UnitOfWork.run(user.id, (uow) => uow.audit.softDelete(params.table, params.id));
    return ok;
  },
  async restore({ params, user }) {
    await UnitOfWork.run(user.id, (uow) => uow.audit.restore(params.table, params.id));
    return ok;
  },
};
