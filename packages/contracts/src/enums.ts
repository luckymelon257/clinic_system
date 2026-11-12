import { z } from 'zod';

// Each enum mirrors a PostgreSQL ENUM type 1:1 (type name in the comment). Labels must match exactly.

export const Role = z.enum(['admin', 'registrar', 'doctor', 'lab_technician', 'cashier', 'patient']); // user_role
export const Sex = z.enum(['male', 'female']); // sex_type
export const BloodType = z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']); // blood_type
export const AppointmentStatus = z.enum(['scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show']); // appointment_status
export const DiagnosisKind = z.enum(['primary', 'secondary']); // diagnosis_kind
export const MedicationForm = z.enum(['tablet', 'capsule', 'syrup', 'injection', 'ointment', 'drops', 'inhaler']); // medication_form
export const LabPriority = z.enum(['routine', 'urgent']); // lab_priority
export const LabOrderStatus = z.enum(['ordered', 'in_progress', 'completed', 'cancelled']); // lab_order_status
export const WardType = z.enum(['general', 'semi_private', 'private', 'icu']); // ward_type
export const BedStatus = z.enum(['available', 'occupied', 'maintenance']); // bed_status
export const AdmissionStatus = z.enum(['active', 'discharged']); // admission_status
export const InvoiceStatus = z.enum(['draft', 'issued', 'partially_paid', 'paid', 'cancelled']); // invoice_status
export const InvoiceItemType = z.enum(['consultation', 'lab_test', 'stay', 'medication', 'procedure']); // invoice_item_type
export const PaymentMethod = z.enum(['cash', 'card', 'bank_transfer', 'insurance']); // payment_method
export const AuditOperation = z.enum(['INSERT', 'UPDATE', 'DELETE', 'SOFT_DELETE', 'RESTORE']); // audit_operation

// Not a PG enum: the whitelist accepted by sp_soft_delete / sp_restore (tables that have deleted_at/deleted_by).
export const SoftDeleteTable = z.enum([
  'users',
  'patients',
  'doctors',
  'departments',
  'wards',
  'beds',
  'medications',
  'insurance_companies',
]);

// ---------- Lab 2 (NoSQL) ----------
export const StaffRole = z.enum(['doctor', 'nurse']); // staff_role
export const InteractionSeverity = z.enum(['minor', 'moderate', 'major']); // interaction_severity
// Not PG enums: discriminators of v_presence / graph labels and engine metadata.
export const PersonKind = z.enum(['patient', 'staff']); // v_presence.person_kind, (:Person:Patient|:Person:Staff)
export const ExposureType = z.enum(['room', 'ward', 'office']); // v_presence.place_kind, (:Place:Room|:Ward|:Office)
export const InteractionVia = z.enum(['direct', 'class']); // medication–medication or class–class
export const EngineStatus = z.enum(['up', 'degraded', 'down']);
export const DataSource = z.enum(['postgres', 'neo4j', 'redis']); // which engine produced the answer
export const VitalSign = z.enum(['hr', 'spo2', 'sbp', 'dbp', 'rr', 'temp']); // ICU monitor (BR-17)

export type Role = z.infer<typeof Role>;
export type Sex = z.infer<typeof Sex>;
export type BloodType = z.infer<typeof BloodType>;
export type AppointmentStatus = z.infer<typeof AppointmentStatus>;
export type DiagnosisKind = z.infer<typeof DiagnosisKind>;
export type MedicationForm = z.infer<typeof MedicationForm>;
export type LabPriority = z.infer<typeof LabPriority>;
export type LabOrderStatus = z.infer<typeof LabOrderStatus>;
export type WardType = z.infer<typeof WardType>;
export type BedStatus = z.infer<typeof BedStatus>;
export type AdmissionStatus = z.infer<typeof AdmissionStatus>;
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;
export type InvoiceItemType = z.infer<typeof InvoiceItemType>;
export type PaymentMethod = z.infer<typeof PaymentMethod>;
export type AuditOperation = z.infer<typeof AuditOperation>;
export type SoftDeleteTable = z.infer<typeof SoftDeleteTable>;
export type StaffRole = z.infer<typeof StaffRole>;
export type InteractionSeverity = z.infer<typeof InteractionSeverity>;
export type PersonKind = z.infer<typeof PersonKind>;
export type ExposureType = z.infer<typeof ExposureType>;
export type InteractionVia = z.infer<typeof InteractionVia>;
export type EngineStatus = z.infer<typeof EngineStatus>;
export type DataSource = z.infer<typeof DataSource>;
export type VitalSign = z.infer<typeof VitalSign>;
