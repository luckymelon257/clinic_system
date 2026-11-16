import { z } from 'zod';
import type { Role } from './enums';
import * as I from './inputs';
import * as M from './models';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteDef {
  method: Method;
  path: string; // Express-style, ':param' segments
  roles: 'public' | 'any' | readonly Role[]; // 'any' = any authenticated user
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  output: z.ZodType;
  status?: 200 | 201; // success status, default 200
  features: readonly string[]; // F-xx from docs/01-requirements.md
  summary: string;
}

const STAFF = ['admin', 'registrar', 'doctor', 'lab_technician', 'cashier'] as const;
const FRONT = ['admin', 'registrar', 'doctor', 'cashier'] as const; // who may see patient data
const CLINICAL = ['admin', 'doctor'] as const;
const INPATIENT = ['admin', 'registrar', 'doctor'] as const;
const FINANCE = ['admin', 'cashier'] as const;
const ADMIN = ['admin'] as const;
const TRIAGE = ['admin', 'registrar', 'doctor'] as const;

const Paged = M.Paged;

/**
 * The single source of truth for the HTTP API. Backend registers exactly these routes,
 * frontend client + MSW mocks are generated from them, Swagger is generated from them.
 * Additive-only during a wave: never rename / remove a key, path, or response field.
 */
export const routes = {
  // ---------- auth / users (F-01..F-03) ----------
  login: { method: 'POST', path: '/api/auth/login', roles: 'public', body: I.LoginInput, output: M.LoginResponse, features: ['F-01'], summary: 'Вхід (email + пароль) → JWT' },
  me: { method: 'GET', path: '/api/auth/me', roles: 'any', output: M.CurrentUser, features: ['F-01', 'F-02'], summary: 'Поточний користувач' },
  listUsers: { method: 'GET', path: '/api/users', roles: ADMIN, query: I.PageQuery, output: Paged(M.User), features: ['F-02'], summary: 'Користувачі' },
  createUser: { method: 'POST', path: '/api/users', roles: ADMIN, body: I.UserCreateInput, output: M.Created, status: 201, features: ['F-01', 'F-02'], summary: 'Створити користувача' },
  setUserActive: { method: 'PATCH', path: '/api/users/:id/active', roles: ADMIN, params: I.IdParams, body: I.UserSetActiveInput, output: M.Ok, features: ['F-03'], summary: 'Активувати / деактивувати' },

  // ---------- reference data (F-10, F-19, F-20, F-22) ----------
  listDepartments: { method: 'GET', path: '/api/departments', roles: 'any', output: z.array(M.Department), features: ['F-10'], summary: 'Відділення' },
  listSpecializations: { method: 'GET', path: '/api/specializations', roles: 'any', output: z.array(M.Specialization), features: ['F-10'], summary: 'Спеціалізації' },
  listInsuranceCompanies: { method: 'GET', path: '/api/insurance-companies', roles: 'any', output: z.array(M.InsuranceCompany), features: ['F-08'], summary: 'Страхові компанії' },
  searchIcd10: { method: 'GET', path: '/api/icd10', roles: 'any', query: I.RefSearchQuery, output: z.array(M.Icd10Code), features: ['F-19'], summary: 'Довідник МКХ-10' },
  searchMedications: { method: 'GET', path: '/api/medications', roles: 'any', query: I.RefSearchQuery, output: z.array(M.Medication), features: ['F-20'], summary: 'Препарати' },
  listLabTestTypes: { method: 'GET', path: '/api/lab-test-types', roles: 'any', output: z.array(M.LabTestType), features: ['F-22'], summary: 'Типи аналізів' },

  // ---------- patients (F-04..F-09) ----------
  searchPatients: { method: 'GET', path: '/api/patients', roles: STAFF, query: I.PatientSearchQuery, output: z.array(M.Patient), features: ['F-05'], summary: 'Нечіткий пошук за ПІБ / телефоном' },
  getPatient: { method: 'GET', path: '/api/patients/:id', roles: STAFF, params: I.IdParams, output: M.Patient, features: ['F-04', 'F-06'], summary: 'Картка пацієнта' },
  createPatient: { method: 'POST', path: '/api/patients', roles: ['admin', 'registrar'], body: I.PatientCreateInput, output: M.Created, status: 201, features: ['F-04'], summary: 'Зареєструвати пацієнта' },
  updatePatient: { method: 'PUT', path: '/api/patients/:id', roles: ['admin', 'registrar'], params: I.IdParams, body: I.PatientUpdateInput, output: M.Patient, features: ['F-06'], summary: 'Редагувати пацієнта' },
  deletePatient: { method: 'DELETE', path: '/api/patients/:id', roles: ['admin', 'registrar'], params: I.IdParams, output: M.Ok, features: ['F-07'], summary: 'Soft delete пацієнта' },
  patientHistory: { method: 'GET', path: '/api/patients/:id/history', roles: FRONT, params: I.IdParams, output: z.array(M.HistoryEvent), features: ['F-09'], summary: 'Медична історія (хронологія)' },
  patientInsurances: { method: 'GET', path: '/api/patients/:id/insurances', roles: FRONT, params: I.IdParams, output: z.array(M.PatientInsurance), features: ['F-08'], summary: 'Поліси пацієнта' },
  addInsurance: { method: 'POST', path: '/api/patients/:id/insurances', roles: ['admin', 'registrar', 'cashier'], params: I.IdParams, body: I.InsuranceCreateInput, output: M.Created, status: 201, features: ['F-08'], summary: 'Додати поліс' },
  register: { method: 'POST', path: '/api/registrations', roles: ['admin', 'registrar'], body: I.RegistrationInput, output: M.RegistrationResult, status: 201, features: ['F-04', 'F-08', 'F-13'], summary: 'Пацієнт + поліс + перший запис (один UoW)' },

  // ---------- doctors (F-11, F-12, F-15) ----------
  listDoctors: { method: 'GET', path: '/api/doctors', roles: 'any', query: I.DoctorListQuery, output: z.array(M.Doctor), features: ['F-11'], summary: 'Лікарі' },
  getDoctor: { method: 'GET', path: '/api/doctors/:id', roles: 'any', params: I.IdParams, output: M.Doctor, features: ['F-11'], summary: 'Лікар' },
  doctorSchedule: { method: 'GET', path: '/api/doctors/:id/schedule', roles: 'any', params: I.IdParams, output: z.array(M.ScheduleEntry), features: ['F-12'], summary: 'Розклад лікаря' },
  freeSlots: { method: 'GET', path: '/api/doctors/:id/free-slots', roles: 'any', params: I.IdParams, query: I.FreeSlotsQuery, output: z.array(M.FreeSlot), features: ['F-15'], summary: 'Вільні слоти на дату' },

  // ---------- appointments (F-13..F-17) ----------
  listAppointments: { method: 'GET', path: '/api/appointments', roles: STAFF, query: I.AppointmentListQuery, output: Paged(M.Appointment), features: ['F-13'], summary: 'Записи на прийом' },
  todayAppointments: { method: 'GET', path: '/api/appointments/today', roles: STAFF, query: I.TodayQuery, output: z.array(M.Appointment), features: ['F-17'], summary: 'Прийоми на сьогодні' },
  getAppointment: { method: 'GET', path: '/api/appointments/:id', roles: STAFF, params: I.IdParams, output: M.Appointment, features: ['F-13'], summary: 'Запис' },
  bookAppointment: { method: 'POST', path: '/api/appointments', roles: ['admin', 'registrar'], body: I.AppointmentBookInput, output: M.Created, status: 201, features: ['F-13', 'F-14'], summary: 'Записати на прийом' },
  rescheduleAppointment: { method: 'PATCH', path: '/api/appointments/:id/reschedule', roles: ['admin', 'registrar'], params: I.IdParams, body: I.AppointmentRescheduleInput, output: M.Ok, features: ['F-13', 'F-14'], summary: 'Перенести' },
  setAppointmentStatus: { method: 'PATCH', path: '/api/appointments/:id/status', roles: ['admin', 'registrar', 'doctor'], params: I.IdParams, body: I.AppointmentStatusInput, output: M.Ok, features: ['F-16'], summary: 'Змінити статус' },
  cancelAppointment: { method: 'POST', path: '/api/appointments/:id/cancel', roles: ['admin', 'registrar'], params: I.IdParams, body: I.AppointmentCancelInput, output: M.Ok, features: ['F-16'], summary: 'Скасувати' },

  // ---------- visit / medical records (F-18..F-21) ----------
  completeVisit: { method: 'POST', path: '/api/visits/:id/complete', roles: CLINICAL, params: I.IdParams, body: I.VisitCompleteInput, output: M.VisitCompleteResult, status: 201, features: ['F-18', 'F-19', 'F-20', 'F-22', 'F-29', 'F-30'], summary: 'Завершити прийом (id = appointment id), один UoW' },
  listMedicalRecords: { method: 'GET', path: '/api/medical-records', roles: CLINICAL, query: I.MedicalRecordListQuery, output: Paged(M.MedicalRecord), features: ['F-09', 'F-18'], summary: 'Медичні записи пацієнта' },
  getMedicalRecord: { method: 'GET', path: '/api/medical-records/:id', roles: CLINICAL, params: I.IdParams, output: M.MedicalRecord, features: ['F-18'], summary: 'Медичний запис' },
  addDiagnosis: { method: 'POST', path: '/api/medical-records/:id/diagnoses', roles: CLINICAL, params: I.IdParams, body: I.DiagnosisInput, output: M.Created, status: 201, features: ['F-19', 'F-21'], summary: 'Доповнити діагнозом (записи лише доповнюються)' },
  listPrescriptions: { method: 'GET', path: '/api/prescriptions', roles: CLINICAL, query: I.PatientIdQuery, output: z.array(M.Prescription), features: ['F-20'], summary: 'Рецепти пацієнта' },

  // ---------- lab (F-22..F-24) ----------
  labQueue: { method: 'GET', path: '/api/lab/queue', roles: ['admin', 'doctor', 'lab_technician'], query: I.LabQueueQuery, output: z.array(M.LabQueueItem), features: ['F-24'], summary: 'Черга незавершених аналізів' },
  createLabOrder: { method: 'POST', path: '/api/lab/orders', roles: CLINICAL, body: I.LabOrderCreateInput, output: M.Created, status: 201, features: ['F-22'], summary: 'Направлення на аналізи' },
  labOrderResults: { method: 'GET', path: '/api/lab/orders/:id/results', roles: ['admin', 'doctor', 'lab_technician'], params: I.IdParams, output: z.array(M.LabResult), features: ['F-23'], summary: 'Результати направлення' },
  recordLabResult: { method: 'POST', path: '/api/lab/orders/:id/results', roles: ['admin', 'lab_technician'], params: I.IdParams, body: I.LabResultInput, output: M.LabResult, status: 201, features: ['F-23'], summary: 'Внести результат (is_abnormal рахує тригер)' },
  patientLabResults: { method: 'GET', path: '/api/lab/results', roles: ['admin', 'doctor', 'lab_technician'], query: I.PatientIdQuery, output: z.array(M.LabResult), features: ['F-23'], summary: 'Результати пацієнта' },

  // ---------- inpatient (F-25..F-28) ----------
  listBeds: { method: 'GET', path: '/api/inpatient/beds', roles: INPATIENT, query: I.BedListQuery, output: z.array(M.Bed), features: ['F-25'], summary: 'Ліжка (карта)' },
  occupancy: { method: 'GET', path: '/api/inpatient/occupancy', roles: INPATIENT, output: z.array(M.Occupancy), features: ['F-28'], summary: 'Заповненість ліжкового фонду' },
  currentAdmissions: { method: 'GET', path: '/api/inpatient/admissions', roles: INPATIENT, output: z.array(M.Admission), features: ['F-26'], summary: 'Пацієнти у стаціонарі зараз' },
  admit: { method: 'POST', path: '/api/inpatient/admissions', roles: INPATIENT, body: I.AdmitInput, output: M.Created, status: 201, features: ['F-26'], summary: 'Госпіталізувати' },
  transfer: { method: 'POST', path: '/api/inpatient/admissions/:id/transfer', roles: INPATIENT, params: I.IdParams, body: I.TransferInput, output: M.Ok, features: ['F-26'], summary: 'Перевести на інше ліжко' },
  discharge: { method: 'POST', path: '/api/inpatient/admissions/:id/discharge', roles: INPATIENT, params: I.IdParams, body: I.DischargeInput, output: M.DischargeResult, features: ['F-27', 'F-29'], summary: 'Виписати + рахунок (один UoW)' },

  // ---------- finance (F-29..F-32) ----------
  listInvoices: { method: 'GET', path: '/api/invoices', roles: FINANCE, query: I.InvoiceListQuery, output: Paged(M.Invoice), features: ['F-32'], summary: 'Рахунки (unpaidOnly → v_unpaid_invoices)' },
  getInvoice: { method: 'GET', path: '/api/invoices/:id', roles: FINANCE, params: I.IdParams, output: M.InvoiceDetail, features: ['F-29'], summary: 'Рахунок з позиціями та оплатами' },
  createInvoice: { method: 'POST', path: '/api/invoices', roles: FINANCE, body: I.InvoiceCreateInput, output: M.Created, status: 201, features: ['F-29', 'F-30'], summary: 'Створити рахунок (поліс підставляється)' },
  addInvoiceItem: { method: 'POST', path: '/api/invoices/:id/items', roles: FINANCE, params: I.IdParams, body: I.InvoiceItemInput, output: M.Created, status: 201, features: ['F-29'], summary: 'Додати позицію (суму рахує тригер)' },
  issueInvoice: { method: 'POST', path: '/api/invoices/:id/issue', roles: FINANCE, params: I.IdParams, body: I.InvoiceIssueInput, output: M.Ok, features: ['F-29'], summary: 'draft → issued' },
  registerPayment: { method: 'POST', path: '/api/invoices/:id/payments', roles: FINANCE, params: I.IdParams, body: I.PaymentInput, output: M.Created, status: 201, features: ['F-31'], summary: 'Оплата (часткова дозволена, BR-7)' },
  revenue: { method: 'GET', path: '/api/reports/revenue', roles: FINANCE, query: I.RevenueQuery, output: z.array(M.RevenueRow), features: ['F-32'], summary: 'Виручка по місяцях (mv_monthly_revenue)' },
  refreshReports: { method: 'POST', path: '/api/reports/refresh', roles: FINANCE, output: M.Ok, features: ['F-32'], summary: 'REFRESH MATERIALIZED VIEW' },

  // ---------- audit / admin (F-07, F-33, F-34) ----------
  auditLog: { method: 'GET', path: '/api/audit', roles: ADMIN, query: I.AuditQuery, output: Paged(M.AuditEntry), features: ['F-33'], summary: 'Журнал аудиту' },
  deletedRecords: { method: 'GET', path: '/api/admin/deleted', roles: ADMIN, query: I.DeletedQuery, output: z.array(M.DeletedRecord), features: ['F-07'], summary: 'Soft-видалені записи' },
  softDelete: { method: 'DELETE', path: '/api/admin/records/:table/:id', roles: ADMIN, params: I.TableIdParams, output: M.Ok, features: ['F-03', 'F-07'], summary: 'Soft delete (sp_soft_delete)' },
  restore: { method: 'POST', path: '/api/admin/records/:table/:id/restore', roles: ADMIN, params: I.TableIdParams, output: M.Ok, features: ['F-07'], summary: 'Відновити (sp_restore)' },

  // ---------- Lab 2: NoSQL (docs/06-nosql-requirements.md F-35..F-45) ----------
  logout: { method: 'POST', path: '/api/auth/logout', roles: 'any', output: M.Ok, features: ['F-42'], summary: 'Вихід: jti → Redis SET auth:revoked:<jti> EX ttl (BR-16)' },
  health: { method: 'GET', path: '/api/health', roles: 'public', output: M.Health, features: ['F-45'], summary: 'Стан PostgreSQL / Neo4j / Redis і відставання графа' },
  traceContacts: { method: 'GET', path: '/api/graph/trace', roles: CLINICAL, query: I.TraceContactsQuery, output: M.TraceResult, features: ['F-35'], summary: 'Відстеження контактів (Neo4j; 503 GRAPH_UNAVAILABLE)' },
  exposurePath: { method: 'GET', path: '/api/graph/path', roles: CLINICAL, query: I.ExposurePathQuery, output: M.ExposurePathResult, features: ['F-36'], summary: 'Найкоротший ланцюг експозиції (Neo4j)' },
  checkInteractions: { method: 'POST', path: '/api/interactions/check', roles: CLINICAL, body: I.InteractionCheckInput, output: M.InteractionCheckResult, features: ['F-37', 'F-39'], summary: 'Взаємодії ліків напряму і через класи (Neo4j, fallback PG)' },
  triageList: { method: 'GET', path: '/api/triage', roles: TRIAGE, output: M.TriageQueue, features: ['F-40'], summary: 'Черга тріажу (Redis ZSET)' },
  triageAdd: { method: 'POST', path: '/api/triage', roles: TRIAGE, body: I.TriageAddInput, output: M.TriageEntry, status: 201, features: ['F-40'], summary: 'Прибуття з ESI 1–5 (ZADD)' },
  triageCallNext: { method: 'POST', path: '/api/triage/next', roles: TRIAGE, output: M.TriageCallResult, features: ['F-40'], summary: 'Викликати наступного (ZPOPMIN, BR-14)' },
  bedCounts: { method: 'GET', path: '/api/inpatient/bed-counts', roles: INPATIENT, output: M.BedCounts, features: ['F-43'], summary: 'Лічильники вільних / зайнятих ліжок (Redis hash, fallback v_beds)' },
  icuBeds: { method: 'GET', path: '/api/icu/beds', roles: CLINICAL, output: z.array(M.IcuBed), features: ['F-44'], summary: 'Ліжка ICU з останніми показниками' },
  icuAlerts: { method: 'GET', path: '/api/icu/alerts', roles: CLINICAL, query: I.IcuAlertsQuery, output: z.array(M.IcuAlert), features: ['F-44'], summary: 'Збережені критичні алерти (PG icu_alerts)' },
  icuStream: { method: 'GET', path: '/api/icu/stream', roles: CLINICAL, output: M.IcuStreamEvent, features: ['F-44'], summary: 'SSE text/event-stream: показники й алерти (Authorization header, без токена в URL)' },
} as const satisfies Record<string, RouteDef>;

export type Routes = typeof routes;
export type RouteName = keyof Routes;

type Infer<T> = T extends z.ZodType ? z.infer<T> : undefined;
type InferIn<T> = T extends z.ZodType ? z.input<T> : undefined;

/** Parsed (post-zod) shapes — what the backend handler receives. */
export type RouteParams<N extends RouteName> = Routes[N] extends { params: infer P } ? Infer<P> : undefined;
export type RouteQuery<N extends RouteName> = Routes[N] extends { query: infer Q } ? Infer<Q> : undefined;
export type RouteBody<N extends RouteName> = Routes[N] extends { body: infer B } ? Infer<B> : undefined;
/** Raw (pre-zod) shapes — what the frontend sends. */
export type RouteParamsIn<N extends RouteName> = Routes[N] extends { params: infer P } ? InferIn<P> : undefined;
export type RouteQueryIn<N extends RouteName> = Routes[N] extends { query: infer Q } ? InferIn<Q> : undefined;
export type RouteBodyIn<N extends RouteName> = Routes[N] extends { body: infer B } ? InferIn<B> : undefined;
export type RouteOutput<N extends RouteName> = z.infer<Routes[N]['output']>;

/** '/api/patients/:id' + {id: 5} → '/api/patients/5' */
export function buildPath(path: string, params?: Record<string, string | number>): string {
  return path.replace(/:(\w+)/g, (_, k: string) => {
    const v = params?.[k];
    if (v === undefined) throw new Error(`Missing path param :${k} for ${path}`);
    return encodeURIComponent(String(v));
  });
}

/** Can `role` call the route? */
export function canAccess(route: RouteDef, role: Role | null): boolean {
  if (route.roles === 'public') return true;
  if (!role) return false;
  return route.roles === 'any' || route.roles.includes(role);
}
