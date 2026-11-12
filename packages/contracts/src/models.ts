import { z } from 'zod';
import {
  AdmissionStatus,
  AppointmentStatus,
  AuditOperation,
  BedStatus,
  BloodType,
  DataSource,
  DiagnosisKind,
  EngineStatus,
  ExposureType,
  InteractionSeverity,
  InteractionVia,
  InvoiceItemType,
  InvoiceStatus,
  LabOrderStatus,
  LabPriority,
  MedicationForm,
  PaymentMethod,
  PersonKind,
  Role,
  Sex,
  SoftDeleteTable,
  StaffRole,
  VitalSign,
  WardType,
} from './enums';

// Response models (camelCase). Conventions:
//   Timestamp = ISO-8601 string with offset (timestamptz), DateOnly = 'YYYY-MM-DD' (date), Money = number (numeric(12,2)).
//   Nullable DB columns are `.nullable()`, never omitted.
const Timestamp = z.string();
const DateOnly = z.string();
const Money = z.number();
const Id = z.number().int();

// Audit stamp shown on edit screens: "last changed by X at Y" (F-06, F-34)
const AuditStamp = {
  createdAt: Timestamp,
  updatedAt: Timestamp.nullable(),
  updatedBy: Id.nullable(),
  updatedByEmail: z.string().nullable(),
};

// ---------- auth / users ----------
export const CurrentUser = z.object({
  id: Id,
  email: z.string(),
  role: Role,
  fullName: z.string(),
  doctorId: Id.nullable(), // set when role = doctor
  patientId: Id.nullable(), // set when role = patient
});
export const LoginResponse = z.object({ token: z.string(), user: CurrentUser });

export const User = z.object({
  id: Id,
  email: z.string(),
  role: Role,
  fullName: z.string(),
  isActive: z.boolean(),
  lastLoginAt: Timestamp.nullable(),
  ...AuditStamp,
});

// ---------- reference data ----------
export const Department = z.object({ id: Id, name: z.string(), headDoctorId: Id.nullable(), headDoctorName: z.string().nullable() });
export const Specialization = z.object({ id: Id, name: z.string() });
export const InsuranceCompany = z.object({ id: Id, name: z.string(), phone: z.string().nullable() });
export const Icd10Code = z.object({ code: z.string(), title: z.string() });
export const Medication = z.object({ id: Id, name: z.string(), form: MedicationForm, strength: z.string().nullable(), unitPrice: Money });
export const LabTestType = z.object({
  id: Id,
  code: z.string(),
  name: z.string(),
  unit: z.string().nullable(),
  refMin: z.number().nullable(),
  refMax: z.number().nullable(),
  price: Money,
});

// ---------- patients ----------
export const Patient = z.object({
  id: Id,
  lastName: z.string(),
  firstName: z.string(),
  middleName: z.string().nullable(),
  fullName: z.string(),
  birthDate: DateOnly,
  age: z.number().int(),
  sex: Sex,
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  bloodType: BloodType.nullable(),
  emergencyContactName: z.string().nullable(),
  emergencyContactPhone: z.string().nullable(),
  // active policy with max coverage (fn_active_insurance), null if none
  insuranceCompanyName: z.string().nullable(),
  insurancePolicyNumber: z.string().nullable(),
  insuranceCoveragePercent: z.number().nullable(),
  ...AuditStamp,
});

export const PatientInsurance = z.object({
  id: Id,
  patientId: Id,
  companyId: Id,
  companyName: z.string(),
  policyNumber: z.string(),
  coveragePercent: z.number(),
  validFrom: DateOnly,
  validTo: DateOnly.nullable(),
  isActive: z.boolean(), // valid today
});

export const HistoryEvent = z.object({
  eventAt: Timestamp,
  eventType: z.enum(['appointment', 'diagnosis', 'prescription', 'lab_order', 'lab_result', 'admission', 'discharge']),
  description: z.string(),
  doctor: z.string().nullable(),
  refId: Id.nullable(), // id of the source row (appointment / record / order / admission)
});

export const RegistrationResult = z.object({
  patientId: Id,
  insuranceId: Id.nullable(),
  appointmentId: Id.nullable(),
});

// ---------- doctors ----------
export const Doctor = z.object({
  id: Id,
  userId: Id,
  fullName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  departmentId: Id,
  departmentName: z.string(),
  specializationId: Id,
  specializationName: z.string(),
  licenseNumber: z.string(),
  consultationFee: Money,
});

export const ScheduleEntry = z.object({
  id: Id,
  doctorId: Id,
  weekday: z.number().int().min(1).max(7), // ISO: 1 = Monday
  weekdayName: z.string(), // Ukrainian day name
  startTime: z.string(), // 'HH:MM'
  endTime: z.string(),
  slotMinutes: z.number().int(),
  room: z.string().nullable(),
});

export const FreeSlot = z.object({ slotStart: Timestamp, slotEnd: Timestamp });

// ---------- appointments ----------
export const Appointment = z.object({
  id: Id,
  patientId: Id,
  patientName: z.string(),
  doctorId: Id,
  doctorName: z.string(),
  departmentName: z.string(),
  specializationName: z.string(),
  startsAt: Timestamp,
  endsAt: Timestamp,
  status: AppointmentStatus,
  reason: z.string().nullable(),
  cancelReason: z.string().nullable(),
  room: z.string().nullable(),
  medicalRecordId: Id.nullable(),
  ...AuditStamp,
});

// ---------- medical records ----------
export const Diagnosis = z.object({
  id: Id,
  medicalRecordId: Id,
  icd10Code: z.string(),
  icd10Title: z.string(),
  kind: DiagnosisKind,
  notes: z.string().nullable(),
});

export const MedicalRecord = z.object({
  id: Id,
  patientId: Id,
  patientName: z.string(),
  doctorId: Id,
  doctorName: z.string(),
  appointmentId: Id.nullable(),
  admissionId: Id.nullable(),
  complaints: z.string().nullable(),
  examination: z.string().nullable(),
  conclusion: z.string().nullable(),
  recommendations: z.string().nullable(),
  diagnosesSummary: z.string().nullable(), // string_agg of "CODE title"
  diagnoses: z.array(Diagnosis),
  createdAt: Timestamp,
});

export const PrescriptionItem = z.object({
  medicationId: Id,
  medicationName: z.string(),
  dosage: z.string(),
  frequency: z.string(),
  durationDays: z.number().int(),
  quantity: z.number().int(),
  instructions: z.string().nullable(),
});

export const Prescription = z.object({
  id: Id,
  medicalRecordId: Id,
  patientId: Id,
  patientName: z.string(),
  doctorName: z.string(),
  issuedAt: Timestamp,
  validUntil: DateOnly.nullable(),
  items: z.array(PrescriptionItem),
});

export const VisitCompleteResult = z.object({
  medicalRecordId: Id,
  diagnosisIds: z.array(Id),
  prescriptionId: Id.nullable(),
  labOrderId: Id.nullable(),
  invoiceId: Id,
});

// ---------- lab ----------
export const LabQueueItem = z.object({
  orderId: Id,
  patientId: Id,
  patientName: z.string(),
  doctorName: z.string(),
  priority: LabPriority,
  status: LabOrderStatus,
  orderedAt: Timestamp,
  testTypeId: Id,
  testCode: z.string(),
  testName: z.string(),
  unit: z.string().nullable(),
  refMin: z.number().nullable(),
  refMax: z.number().nullable(),
});

export const LabResult = z.object({
  id: Id,
  orderId: Id,
  patientId: Id,
  patientName: z.string(),
  testTypeId: Id,
  testCode: z.string(),
  testName: z.string(),
  valueNumeric: z.number().nullable(),
  valueText: z.string().nullable(),
  unit: z.string().nullable(),
  refMin: z.number().nullable(),
  refMax: z.number().nullable(),
  isAbnormal: z.boolean().nullable(), // null when no numeric reference range
  recordedAt: Timestamp,
  recordedByEmail: z.string().nullable(),
});

// ---------- inpatient ----------
export const Bed = z.object({
  id: Id,
  bedNumber: z.string(),
  status: BedStatus,
  wardId: Id,
  wardNumber: z.string(),
  wardType: WardType,
  dailyRate: Money,
  departmentId: Id,
  departmentName: z.string(),
  admissionId: Id.nullable(), // current active admission on this bed
  patientId: Id.nullable(),
  patientName: z.string().nullable(),
});

export const Admission = z.object({
  id: Id,
  patientId: Id,
  patientName: z.string(),
  bedId: Id,
  bedNumber: z.string(),
  wardNumber: z.string(),
  departmentName: z.string(),
  doctorId: Id,
  doctorName: z.string(),
  admittedAt: Timestamp,
  dischargedAt: Timestamp.nullable(),
  reason: z.string().nullable(),
  dischargeSummary: z.string().nullable(),
  status: AdmissionStatus,
  days: z.number().int(),
});

export const Occupancy = z.object({
  departmentId: Id,
  departmentName: z.string(),
  wardId: Id.nullable(), // null row = department total
  wardNumber: z.string().nullable(),
  totalBeds: z.number().int(),
  occupiedBeds: z.number().int(),
  occupancyPercent: z.number(),
});

export const DischargeResult = z.object({ admissionId: Id, invoiceId: Id });

// ---------- finance ----------
export const Invoice = z.object({
  id: Id,
  number: z.string(),
  patientId: Id,
  patientName: z.string(),
  appointmentId: Id.nullable(),
  admissionId: Id.nullable(),
  status: InvoiceStatus,
  subtotal: Money,
  insuranceCoveragePercent: z.number(),
  insuranceAmount: Money,
  totalDue: Money,
  paidAmount: Money,
  balance: Money,
  issuedAt: Timestamp.nullable(),
  dueDate: DateOnly.nullable(),
  isOverdue: z.boolean(),
  createdAt: Timestamp,
});

export const InvoiceItem = z.object({
  id: Id,
  invoiceId: Id,
  itemType: InvoiceItemType,
  description: z.string(),
  quantity: z.number(),
  unitPrice: Money,
  amount: Money,
});

export const Payment = z.object({
  id: Id,
  invoiceId: Id,
  amount: Money,
  method: PaymentMethod,
  reference: z.string().nullable(),
  paidAt: Timestamp,
  receivedByEmail: z.string().nullable(),
});

export const InvoiceDetail = Invoice.extend({ items: z.array(InvoiceItem), payments: z.array(Payment) });

export const RevenueRow = z.object({
  month: DateOnly, // first day of month
  departmentName: z.string(),
  method: PaymentMethod,
  paymentsCount: z.number().int(),
  total: Money,
});

// ---------- audit / admin ----------
export const AuditEntry = z.object({
  id: Id,
  tableName: z.string(),
  recordId: Id,
  operation: AuditOperation,
  changedFields: z.array(z.string()).nullable(),
  oldData: z.record(z.string(), z.unknown()).nullable(),
  newData: z.record(z.string(), z.unknown()).nullable(),
  changedAt: Timestamp,
  changedBy: Id.nullable(),
  changedByEmail: z.string().nullable(),
});

export const DeletedRecord = z.object({
  tableName: SoftDeleteTable,
  recordId: Id,
  label: z.string(), // human readable: patient full name, user email, ward number...
  deletedAt: Timestamp,
  deletedBy: Id.nullable(),
  deletedByEmail: z.string().nullable(),
});

export const Ok = z.object({ ok: z.literal(true) });
export const Created = z.object({ id: Id });

export const Paged = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), total: z.number().int() });

// ---------- Lab 2: graph read-model (F-35, F-36, F-37, BR-11) ----------
// Every graph answer says which engine produced it and how stale the read-model was (asOf / lagMs).
const Freshness = {
  engine: DataSource,
  asOf: Timestamp, // PG time up to which the outbox was applied when the query ran
  lagMs: z.number().int().nonnegative(), // age of the oldest unapplied outbox event (0 = in sync)
};

export const PersonRef = z.object({ kind: PersonKind, id: Id, name: z.string(), role: StaffRole.nullable() });

export const TraceContact = z.object({
  kind: PersonKind,
  id: Id,
  name: z.string(),
  role: StaffRole.nullable(), // null for patients
  hops: z.number().int().min(1), // minimal number of person→place→person steps (D-25)
  // One witness edge that reached this person at `hops` (draws the BFS tree in the UI)
  parentKind: PersonKind,
  parentId: Id,
  exposure: ExposureType,
  placeId: Id,
  placeName: z.string().nullable(),
  overlapMinutes: z.number().nonnegative(), // overlap of that witness contact, clipped to the window
});

export const TraceResult = z.object({
  index: PersonRef,
  from: Timestamp,
  to: Timestamp,
  depth: z.number().int(),
  contacts: z.array(TraceContact),
  tookMs: z.number().nonnegative(),
  ...Freshness,
});

export const PathStep = z.discriminatedUnion('type', [
  z.object({ type: z.literal('person'), kind: PersonKind, id: Id, name: z.string() }),
  z.object({ type: z.literal('place'), kind: ExposureType, id: Id, name: z.string().nullable(), from: Timestamp, to: Timestamp }),
]);

export const ExposurePathResult = z.object({
  found: z.boolean(),
  hops: z.number().int().nullable(), // null = not connected within maxDepth
  steps: z.array(PathStep), // person, place, person, … (empty when not found)
  ...Freshness,
});

export const DrugInteraction = z.object({
  medicationAId: Id, // medicationAId < medicationBId
  medicationAName: z.string(),
  medicationBId: Id,
  medicationBName: z.string(),
  severity: InteractionSeverity,
  via: InteractionVia,
  classAId: Id.nullable(), // class of medication A (via = 'class')
  classAName: z.string().nullable(),
  classBId: Id.nullable(),
  classBName: z.string().nullable(),
});

export const InteractionCheckResult = z.object({
  interactions: z.array(DrugInteraction),
  maxSeverity: InteractionSeverity.nullable(),
  requiresAcknowledgement: z.boolean(), // any `major` → BR-13
  currentMedicationIds: z.array(Id), // what the patient takes at `at` (empty without patientId)
  ...Freshness, // engine = 'postgres' when Neo4j is down (fallback, D-28)
});

// ---------- Lab 2: Redis-backed operational state (F-40…F-45) ----------
export const TriageEntry = z.object({
  id: Id,
  patientId: Id.nullable(),
  patientName: z.string(),
  esi: z.number().int().min(1).max(5),
  complaint: z.string(),
  arrivedAt: Timestamp,
  position: z.number().int().min(0), // 1-based place in the queue; 0 once called
});

export const TriageQueue = z.object({ items: z.array(TriageEntry), total: z.number().int(), source: DataSource });
export const TriageCallResult = z.object({ entry: TriageEntry.nullable(), remaining: z.number().int() });

export const BedCount = z.object({
  wardId: Id,
  wardNumber: z.string(),
  wardType: WardType,
  departmentId: Id,
  departmentName: z.string(),
  total: z.number().int(),
  free: z.number().int(),
  occupied: z.number().int(),
});

export const BedCounts = z.object({
  items: z.array(BedCount),
  source: DataSource, // 'redis' (HINCRBY counters) or 'postgres' (v_beds) when Redis is down
  reconciledAt: Timestamp.nullable(), // last reconciliation of counters with v_beds
});

export const EngineHealth = z.object({ status: EngineStatus, latencyMs: z.number().nullable(), error: z.string().nullable() });

export const Health = z.object({
  status: EngineStatus, // up = all up; degraded = PG up, Neo4j or Redis down; down = PG down
  postgres: EngineHealth,
  neo4j: EngineHealth,
  redis: EngineHealth,
  graphSync: z.object({ pending: z.number().int().nullable(), lagMs: z.number().int().nullable(), lastProcessedAt: Timestamp.nullable() }),
  checkedAt: Timestamp,
});

export const Vitals = z.object({
  hr: z.number(), // heart rate, 1/min
  spo2: z.number(), // %
  sbp: z.number(), // systolic BP, mmHg
  dbp: z.number(), // diastolic BP, mmHg
  rr: z.number(), // respiratory rate, 1/min
  temp: z.number(), // °C
  at: Timestamp,
});

export const IcuBed = z.object({
  bedId: Id,
  bedNumber: z.string(),
  wardId: Id,
  wardNumber: z.string(),
  patientId: Id.nullable(),
  patientName: z.string().nullable(),
  vitals: Vitals.nullable(), // latest reading (icu:latest:{bedId}), null when the monitor is silent
  alerting: z.boolean(),
});

export const VitalViolation = z.object({ sign: VitalSign, value: z.number(), rule: z.string() }); // rule e.g. '< 88'

export const IcuAlert = z.object({
  id: z.string(), // Redis Stream entry id of the reading that triggered it
  bedId: Id,
  patientId: Id.nullable(),
  patientName: z.string().nullable(),
  violations: z.array(VitalViolation).min(1),
  vitals: Vitals,
  at: Timestamp,
});

// GET /icu/stream is text/event-stream; each `data:` line is one of these JSON objects
export const IcuStreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('vitals'), bedId: Id, vitals: Vitals }),
  z.object({ type: z.literal('alert'), alert: IcuAlert }),
  z.object({ type: z.literal('ping'), at: Timestamp }),
]);

export type PersonRef = z.infer<typeof PersonRef>;
export type TraceContact = z.infer<typeof TraceContact>;
export type TraceResult = z.infer<typeof TraceResult>;
export type PathStep = z.infer<typeof PathStep>;
export type ExposurePathResult = z.infer<typeof ExposurePathResult>;
export type DrugInteraction = z.infer<typeof DrugInteraction>;
export type InteractionCheckResult = z.infer<typeof InteractionCheckResult>;
export type TriageEntry = z.infer<typeof TriageEntry>;
export type TriageQueue = z.infer<typeof TriageQueue>;
export type TriageCallResult = z.infer<typeof TriageCallResult>;
export type BedCount = z.infer<typeof BedCount>;
export type BedCounts = z.infer<typeof BedCounts>;
export type EngineHealth = z.infer<typeof EngineHealth>;
export type Health = z.infer<typeof Health>;
export type Vitals = z.infer<typeof Vitals>;
export type IcuBed = z.infer<typeof IcuBed>;
export type VitalViolation = z.infer<typeof VitalViolation>;
export type IcuAlert = z.infer<typeof IcuAlert>;
export type IcuStreamEvent = z.infer<typeof IcuStreamEvent>;

export type CurrentUser = z.infer<typeof CurrentUser>;
export type LoginResponse = z.infer<typeof LoginResponse>;
export type User = z.infer<typeof User>;
export type Department = z.infer<typeof Department>;
export type Specialization = z.infer<typeof Specialization>;
export type InsuranceCompany = z.infer<typeof InsuranceCompany>;
export type Icd10Code = z.infer<typeof Icd10Code>;
export type Medication = z.infer<typeof Medication>;
export type LabTestType = z.infer<typeof LabTestType>;
export type Patient = z.infer<typeof Patient>;
export type PatientInsurance = z.infer<typeof PatientInsurance>;
export type HistoryEvent = z.infer<typeof HistoryEvent>;
export type RegistrationResult = z.infer<typeof RegistrationResult>;
export type Doctor = z.infer<typeof Doctor>;
export type ScheduleEntry = z.infer<typeof ScheduleEntry>;
export type FreeSlot = z.infer<typeof FreeSlot>;
export type Appointment = z.infer<typeof Appointment>;
export type Diagnosis = z.infer<typeof Diagnosis>;
export type MedicalRecord = z.infer<typeof MedicalRecord>;
export type PrescriptionItem = z.infer<typeof PrescriptionItem>;
export type Prescription = z.infer<typeof Prescription>;
export type VisitCompleteResult = z.infer<typeof VisitCompleteResult>;
export type LabQueueItem = z.infer<typeof LabQueueItem>;
export type LabResult = z.infer<typeof LabResult>;
export type Bed = z.infer<typeof Bed>;
export type Admission = z.infer<typeof Admission>;
export type Occupancy = z.infer<typeof Occupancy>;
export type DischargeResult = z.infer<typeof DischargeResult>;
export type Invoice = z.infer<typeof Invoice>;
export type InvoiceItem = z.infer<typeof InvoiceItem>;
export type Payment = z.infer<typeof Payment>;
export type InvoiceDetail = z.infer<typeof InvoiceDetail>;
export type RevenueRow = z.infer<typeof RevenueRow>;
export type AuditEntry = z.infer<typeof AuditEntry>;
export type DeletedRecord = z.infer<typeof DeletedRecord>;
export type Ok = z.infer<typeof Ok>;
export type Created = z.infer<typeof Created>;
