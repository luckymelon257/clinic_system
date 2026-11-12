import { z } from 'zod';
import {
  AppointmentStatus,
  BloodType,
  DiagnosisKind,
  InvoiceItemType,
  InvoiceStatus,
  LabPriority,
  PaymentMethod,
  PersonKind,
  Role,
  Sex,
  SoftDeleteTable,
} from './enums';

// Request bodies, query strings and path params. Messages are Ukrainian because the UI shows them as-is.

const req = 'Обовʼязкове поле';
const text = (max = 255) => z.string().trim().min(1, req).max(max);
const optText = (max = 2000) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const DateOnly = z.iso.date({ message: 'Дата у форматі YYYY-MM-DD' });
const DateTime = z.iso.datetime({ offset: true, message: 'Дата й час у форматі ISO-8601' });
const Phone = z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Невірний формат телефону');
const IdParam = z.coerce.number().int().positive();
const Money = z.number().nonnegative().multipleOf(0.01);

// ---------- path params ----------
export const IdParams = z.object({ id: IdParam });
export const TableIdParams = z.object({ table: SoftDeleteTable, id: IdParam });

// ---------- query helpers ----------
const limit = z.coerce.number().int().min(1).max(200).default(50);
const offset = z.coerce.number().int().min(0).default(0);
export const PageQuery = z.object({ limit, offset });

// ---------- auth / users ----------
export const LoginInput = z.object({
  email: z.email('Невірний email').trim().toLowerCase(),
  password: z.string().min(1, req),
});
export const UserCreateInput = z.object({
  email: z.email('Невірний email').trim().toLowerCase(),
  password: z.string().min(8, 'Мінімум 8 символів'),
  role: Role,
  fullName: text(200),
});
export const UserSetActiveInput = z.object({ isActive: z.boolean() });

// ---------- patients ----------
export const PatientInput = z.object({
  lastName: text(100),
  firstName: text(100),
  middleName: optText(100),
  birthDate: DateOnly,
  sex: Sex,
  phone: Phone.nullish().transform((v) => v ?? null),
  email: z.email('Невірний email').nullish().transform((v) => v ?? null),
  address: optText(500),
  bloodType: BloodType.nullish().transform((v) => v ?? null),
  emergencyContactName: optText(200),
  emergencyContactPhone: Phone.nullish().transform((v) => v ?? null),
});
export const PatientCreateInput = PatientInput;
export const PatientUpdateInput = PatientInput; // PUT: full replacement, audit fields are set by the trigger

export const PatientSearchQuery = z.object({
  q: z.string().trim().max(100).default(''), // empty = most recently updated
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const InsuranceCreateInput = z
  .object({
    companyId: z.number().int().positive(),
    policyNumber: text(50),
    coveragePercent: z.number().min(0).max(100), // BR-10
    validFrom: DateOnly,
    validTo: DateOnly.nullish().transform((v) => v ?? null),
  })
  .refine((v) => !v.validTo || v.validTo >= v.validFrom, { path: ['validTo'], message: 'Кінець дії раніше за початок' });

export const AppointmentBookInput = z.object({
  patientId: z.number().int().positive(),
  doctorId: z.number().int().positive(),
  startsAt: DateTime, // must equal a slotStart from free-slots; duration = schedule.slot_minutes
  reason: optText(500),
});

// F-04 + F-08 + F-13 in one UoW (RegistrationService)
export const RegistrationInput = z.object({
  patient: PatientCreateInput,
  insurance: InsuranceCreateInput.nullish().transform((v) => v ?? null),
  appointment: AppointmentBookInput.omit({ patientId: true }).nullish().transform((v) => v ?? null),
});

// ---------- doctors ----------
export const DoctorListQuery = z.object({
  departmentId: z.coerce.number().int().positive().optional(),
  specializationId: z.coerce.number().int().positive().optional(),
});
export const FreeSlotsQuery = z.object({ date: DateOnly });

// ---------- appointments ----------
export const AppointmentListQuery = z.object({
  doctorId: z.coerce.number().int().positive().optional(),
  patientId: z.coerce.number().int().positive().optional(),
  date: DateOnly.optional(),
  status: AppointmentStatus.optional(),
  limit,
  offset,
});
export const TodayQuery = z.object({
  doctorId: z.coerce.number().int().positive().optional(),
  departmentId: z.coerce.number().int().positive().optional(),
});
export const AppointmentRescheduleInput = z.object({ startsAt: DateTime });
export const AppointmentStatusInput = z.object({ status: AppointmentStatus });
export const AppointmentCancelInput = z.object({ reason: text(500) });

// ---------- medical records / visit ----------
export const DiagnosisInput = z.object({
  icd10Code: z.string().trim().toUpperCase().regex(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/, 'Невірний код МКХ-10'),
  kind: DiagnosisKind,
  notes: optText(1000),
});

export const PrescriptionItemInput = z.object({
  medicationId: z.number().int().positive(),
  dosage: text(100),
  frequency: text(100),
  durationDays: z.number().int().min(1).max(365),
  quantity: z.number().int().min(1).max(1000),
  instructions: optText(500),
});

export const PrescriptionInput = z.object({
  validUntil: DateOnly.nullish().transform((v) => v ?? null),
  items: z.array(PrescriptionItemInput).min(1, 'Хоча б одна позиція'),
});

export const LabOrderInlineInput = z.object({
  priority: LabPriority,
  testCodes: z.array(z.string().trim().min(1)).min(1, 'Хоча б один аналіз'),
});

// POST /visits/:id/complete — one UoW: record + diagnoses + prescription + lab order + consultation invoice
export const VisitCompleteInput = z
  .object({
    complaints: optText(),
    examination: optText(),
    conclusion: text(4000),
    recommendations: optText(),
    diagnoses: z.array(DiagnosisInput).min(1, 'Хоча б один діагноз'),
    prescription: PrescriptionInput.nullish().transform((v) => v ?? null),
    labOrder: LabOrderInlineInput.nullish().transform((v) => v ?? null),
    // BR-13 (Lab 2): a `major` interaction does not block, but the doctor must confirm it explicitly
    interactionsAcknowledged: z.boolean().optional(),
  })
  .refine((v) => v.diagnoses.filter((d) => d.kind === 'primary').length === 1, {
    path: ['diagnoses'],
    message: 'Рівно один основний діагноз',
  });

export const MedicalRecordListQuery = z.object({ patientId: z.coerce.number().int().positive(), limit, offset });
export const PatientIdQuery = z.object({ patientId: z.coerce.number().int().positive() });

// ---------- reference search ----------
export const RefSearchQuery = z.object({
  q: z.string().trim().max(100).default(''),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ---------- lab ----------
export const LabQueueQuery = z.object({ priority: LabPriority.optional() });
export const LabOrderCreateInput = z.object({
  patientId: z.number().int().positive(),
  doctorId: z.number().int().positive(),
  medicalRecordId: z.number().int().positive().nullish().transform((v) => v ?? null),
  priority: LabPriority,
  testCodes: z.array(z.string().trim().min(1)).min(1, 'Хоча б один аналіз'),
});
export const LabResultInput = z
  .object({
    testTypeId: z.number().int().positive(),
    valueNumeric: z.number().nullish().transform((v) => v ?? null),
    valueText: optText(500),
  })
  .refine((v) => v.valueNumeric !== null || v.valueText !== null, {
    path: ['valueNumeric'],
    message: 'Вкажіть числове або текстове значення',
  });

// ---------- inpatient ----------
export const BedListQuery = z.object({
  departmentId: z.coerce.number().int().positive().optional(),
  status: z.enum(['available', 'occupied', 'maintenance']).optional(),
});
export const AdmitInput = z.object({
  patientId: z.number().int().positive(),
  bedId: z.number().int().positive(),
  doctorId: z.number().int().positive(),
  reason: optText(1000),
});
export const TransferInput = z.object({ bedId: z.number().int().positive() });
export const DischargeInput = z.object({ summary: text(4000) });

// ---------- finance ----------
export const InvoiceListQuery = z.object({
  patientId: z.coerce.number().int().positive().optional(),
  status: InvoiceStatus.optional(),
  unpaidOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'), // true -> v_unpaid_invoices
  limit,
  offset,
});
export const InvoiceCreateInput = z.object({
  patientId: z.number().int().positive(),
  appointmentId: z.number().int().positive().nullish().transform((v) => v ?? null),
  admissionId: z.number().int().positive().nullish().transform((v) => v ?? null),
});
export const InvoiceItemInput = z.object({
  itemType: InvoiceItemType,
  description: text(300),
  quantity: z.number().positive().max(10000),
  unitPrice: Money,
});
export const InvoiceIssueInput = z.object({ dueDays: z.number().int().min(0).max(365).default(14) });
export const PaymentInput = z.object({
  amount: z.number().positive('Сума має бути більшою за 0').multipleOf(0.01),
  method: PaymentMethod,
  reference: optText(100),
});
export const RevenueQuery = z.object({ from: DateOnly.optional(), to: DateOnly.optional() });

// ---------- audit / admin ----------
export const AuditQuery = z.object({
  tableName: z.string().trim().max(63).optional(),
  recordId: z.coerce.number().int().positive().optional(),
  changedBy: z.coerce.number().int().positive().optional(),
  operation: z.enum(['INSERT', 'UPDATE', 'DELETE', 'SOFT_DELETE', 'RESTORE']).optional(),
  limit,
  offset,
});
export const DeletedQuery = z.object({ tableName: SoftDeleteTable.optional() });

// ---------- Lab 2: graph (F-35, F-36, F-37), BR-12 ----------
export const TRACE_MAX_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;
type Window = { from: string; to: string };
const windowOrdered = (v: Window) => Date.parse(v.from) < Date.parse(v.to);
const windowShort = (v: Window) => Date.parse(v.to) - Date.parse(v.from) <= TRACE_MAX_WINDOW_DAYS * DAY_MS;
const ORDERED = { path: ['to'], message: 'Кінець вікна має бути пізніше за початок' };
const SHORT = { path: ['to'], message: `Вікно не довше ${TRACE_MAX_WINDOW_DAYS} днів` };

// GET /graph/trace — window [from, to) half-open, depth 1..5
export const TraceContactsQuery = z
  .object({
    personKind: PersonKind.default('patient'),
    personId: z.coerce.number().int().positive(),
    from: DateTime,
    to: DateTime,
    depth: z.coerce.number().int().min(1).max(5).default(2),
  })
  .refine(windowOrdered, ORDERED)
  .refine(windowShort, SHORT);

// GET /graph/path — shortest exposure chain between two persons (null when not connected within maxDepth)
export const ExposurePathQuery = z
  .object({
    aKind: PersonKind.default('patient'),
    aId: z.coerce.number().int().positive(),
    bKind: PersonKind.default('patient'),
    bId: z.coerce.number().int().positive(),
    from: DateTime,
    to: DateTime,
    maxDepth: z.coerce.number().int().min(1).max(8).default(6),
  })
  .refine(windowOrdered, ORDERED)
  .refine(windowShort, SHORT)
  .refine((v) => v.aKind !== v.bKind || v.aId !== v.bId, { path: ['bId'], message: 'Оберіть дві різні особи' });

// POST /interactions/check — new medications vs each other and (optionally) what the patient takes at `at`
export const InteractionCheckInput = z.object({
  medicationIds: z.array(z.number().int().positive()).min(1, 'Хоча б один препарат').max(20),
  patientId: z.number().int().positive().nullish().transform((v) => v ?? null),
  at: DateTime.nullish().transform((v) => v ?? null), // null = now
});

// ---------- Lab 2: Redis-backed (F-40, F-44) ----------
export const TriageAddInput = z.object({
  patientId: z.number().int().positive().nullish().transform((v) => v ?? null), // unknown arrivals allowed
  patientName: text(200),
  esi: z.number().int().min(1, 'ESI 1–5').max(5, 'ESI 1–5'), // 1 = resuscitation … 5 = non-urgent
  complaint: text(500),
});

export const IcuAlertsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  bedId: z.coerce.number().int().positive().optional(),
});

export type TraceContactsQuery = z.infer<typeof TraceContactsQuery>;
export type ExposurePathQuery = z.infer<typeof ExposurePathQuery>;
export type InteractionCheckInput = z.infer<typeof InteractionCheckInput>;
export type TriageAddInput = z.infer<typeof TriageAddInput>;
export type IcuAlertsQuery = z.infer<typeof IcuAlertsQuery>;

export type LoginInput = z.infer<typeof LoginInput>;
export type UserCreateInput = z.infer<typeof UserCreateInput>;
export type UserSetActiveInput = z.infer<typeof UserSetActiveInput>;
export type PatientInput = z.infer<typeof PatientInput>;
export type PatientSearchQuery = z.infer<typeof PatientSearchQuery>;
export type InsuranceCreateInput = z.infer<typeof InsuranceCreateInput>;
export type AppointmentBookInput = z.infer<typeof AppointmentBookInput>;
export type RegistrationInput = z.infer<typeof RegistrationInput>;
export type DoctorListQuery = z.infer<typeof DoctorListQuery>;
export type FreeSlotsQuery = z.infer<typeof FreeSlotsQuery>;
export type AppointmentListQuery = z.infer<typeof AppointmentListQuery>;
export type TodayQuery = z.infer<typeof TodayQuery>;
export type AppointmentRescheduleInput = z.infer<typeof AppointmentRescheduleInput>;
export type AppointmentStatusInput = z.infer<typeof AppointmentStatusInput>;
export type AppointmentCancelInput = z.infer<typeof AppointmentCancelInput>;
export type DiagnosisInput = z.infer<typeof DiagnosisInput>;
export type PrescriptionItemInput = z.infer<typeof PrescriptionItemInput>;
export type PrescriptionInput = z.infer<typeof PrescriptionInput>;
export type VisitCompleteInput = z.infer<typeof VisitCompleteInput>;
export type LabOrderCreateInput = z.infer<typeof LabOrderCreateInput>;
export type LabResultInput = z.infer<typeof LabResultInput>;
export type AdmitInput = z.infer<typeof AdmitInput>;
export type TransferInput = z.infer<typeof TransferInput>;
export type DischargeInput = z.infer<typeof DischargeInput>;
export type InvoiceListQuery = z.infer<typeof InvoiceListQuery>;
export type InvoiceCreateInput = z.infer<typeof InvoiceCreateInput>;
export type InvoiceItemInput = z.infer<typeof InvoiceItemInput>;
export type InvoiceIssueInput = z.infer<typeof InvoiceIssueInput>;
export type PaymentInput = z.infer<typeof PaymentInput>;
export type RevenueQuery = z.infer<typeof RevenueQuery>;
export type AuditQuery = z.infer<typeof AuditQuery>;
export type DeletedQuery = z.infer<typeof DeletedQuery>;
