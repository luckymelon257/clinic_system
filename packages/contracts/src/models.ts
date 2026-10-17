import { z } from 'zod';
import {
  AdmissionStatus,
  AppointmentStatus,
  AuditOperation,
  BedStatus,
  BloodType,
  DiagnosisKind,
  InvoiceItemType,
  InvoiceStatus,
  LabOrderStatus,
  LabPriority,
  MedicationForm,
  PaymentMethod,
  Role,
  Sex,
  SoftDeleteTable,
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
