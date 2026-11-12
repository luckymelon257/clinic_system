# SQL API (`@clinic/db`) — the backend's only interface to PostgreSQL

Reads: **only** `v_*` / `mv_*` views and `fn_*` functions. Writes: **only** `CALL sp_*`.
Signatures below are copied from `pg_get_function_arguments` / `pg_attribute` of a migrated database.

## 1. Conventions

| Topic | Rule |
|---|---|
| Current user | Every Unit of Work: `BEGIN; SELECT set_config('app.current_user_id', $1, true)` (string id, `''` = anonymous). Triggers fill `created_by/updated_by/deleted_by`, `audit_log.changed_by`, `payments`→`received_by_email`, `lab_results`→`recorded_by_email` from it. |
| Ids from procedures | The last parameter is `INOUT p_id int DEFAULT NULL` (or `p_invoice_id`). Call `CALL sp_x($1, …, NULL)`; the result has **one row** `{ p_id: number }` (`{ p_invoice_id }` for `sp_discharge_patient`, `sp_invoice_generate_for_admission`). |
| Column names | snake_case of the contract model fields (`Patient.updatedByEmail` → `v_patients.updated_by_email`). Extra columns (e.g. `department_id`, `doctor_id`, `patient_id`) exist only for filtering. |
| Nested arrays | `jsonb` with camelCase keys of the nested model: `v_medical_records.diagnoses` (Diagnosis[]), `v_prescriptions.items` (PrescriptionItem[]). `v_audit_log.old_data/new_data` are raw `to_jsonb(row)` (snake_case, `password_hash` stripped). |
| Types → node-pg | `int` → number. **`numeric` arrives as string** — register `types.setTypeParser(1700, parseFloat)`. **`date` (1082)** is parsed into a JS Date by default — register `setTypeParser(1082, v => v)` to keep `'YYYY-MM-DD'`. `timestamptz` → Date (serialize with `toISOString()`). Enums → string. `text[]` → string[]. No `bigint` columns in views. |
| Time zone | DB default `Europe/Kyiv` (`ALTER DATABASE … SET timezone`). Slots, "today", weekdays are computed in that zone. |
| Errors | `RAISE … USING ERRCODE`. Messages are Ukrainian and safe to show. Map with `errorCodeForSqlState` from `@clinic/contracts`. |
| Passwords | Hashes are bcrypt `$2a$` (pgcrypto `crypt(pw, gen_salt('bf', 10))` in seeds) — verify with `bcryptjs.compare`. New users: hash in the API, pass to `sp_user_create`. |

### SQLSTATEs raised by this package

| SQLSTATE | HTTP | Meaning |
|---|---|---|
| `P0002` | 404 | row not found (also soft-deleted for update procedures) |
| `P0403` | 403 | forbidden: `sp_restore` by non-admin; `DELETE` on medical_records / diagnoses / prescriptions / prescription_items / payments (BR-5); changing `created_at/created_by` |
| `P0409` | 409 | conflict: doctor busy (BR-1), bed not available / patient already admitted (BR-2), duplicate email / policy / primary diagnosis / lab result / invoice, deactivating or deleting yourself, deleting an occupied bed |
| `23P01` | 409 | EXCLUDE violation (race on BR-1 / BR-2) — constraint `ex_appointments_doctor_overlap` / `ex_admissions_bed_active` |
| `23505` | 409 | unique violation (e.g. `ux_users_email_active` on restore) |
| `P0003` | 422 | birth date in the future |
| `P0004` / `P0005` | 422 | patient / doctor is soft-deleted (BR-4) |
| `P0020` | 422 | outside doctor schedule or off the slot grid / doctor does not work that day (BR-3) |
| `P0021` | 422 | booking / rescheduling into the past |
| `P0030` | 422 | reschedule allowed only for `scheduled` / `confirmed` |
| `P0031` | 422 | forbidden appointment status transition / change of a completed, cancelled or no-show appointment (trigger) |
| `P0040` | 422 | medical record needs exactly one of appointment / admission |
| `P0041` | 422 | visit on a cancelled / no-show / completed appointment |
| `P0042` | 422 | unknown ICD-10 code |
| `P0043` / `P0044` / `P0045` | 422 | prescription: no items / medication missing or deleted / `valid_until` in the past |
| `P0050` | 422 | lab order: no or unknown test codes |
| `P0051` / `P0052` / `P0053` | 422 | lab result: order closed / test not in order / no value |
| `P0060` / `P0061` | 422 | admission already discharged / transfer to the same bed |
| `P0070` | 422 | appointment / admission / record does not belong to the patient |
| `P0071` / `P0072` / `P0074` | 422 | invoice: items only on `draft` / issue only `draft` / empty invoice |
| `P0073` / `P0075` / `P0076` | 422 | payment: invoice not `issued`/`partially_paid` / amount exceeds balance (BR-7) / amount ≤ 0 |
| `23514` | 422 | CHECK: coverage 0–100 (BR-10), `ends_at > starts_at`, discharge ≥ admission (BR-9), phone format (`d_phone`), money ≥ 0 (`d_money`), quantity > 0 … |
| `22023` | 400 | `sp_soft_delete` / `sp_restore` table not in the whitelist (`SoftDeleteTable`) |
| `22P02` | 400 | invalid enum label / number text |

## 2. Functions

| Signature | Returns | Notes |
|---|---|---|
| `fn_auth_user(p_email text)` | `TABLE(id int, email text, role user_role, full_name text, password_hash text, is_active boolean, doctor_id int, patient_id int)` | Login only. Case-insensitive email, non-deleted users. 0 rows = unknown email. Check `is_active` in the API. The only object exposing `password_hash`. |
| `fn_search_patients(p_query text, p_limit int DEFAULT 20)` | `SETOF v_patients` | Trigram fuzzy match / `ILIKE` on `last_name || ' ' || first_name`, plus phone digits (≥ 3 digits). Ordered by similarity; empty query → most recently created/updated. |
| `fn_patient_history(p_patient_id int)` | `TABLE(event_at timestamptz, event_type text, description text, doctor text, ref_id int)` | `event_type` ∈ `appointment, diagnosis, prescription, lab_order, lab_result, admission, discharge`. `ref_id`: appointment id / medical record id (diagnosis, prescription) / lab order id / admission id. Newest first. `P0002` if no such patient. |
| `fn_doctor_free_slots(p_doctor_id int, p_date date)` | `TABLE(slot_start timestamptz, slot_end timestamptz)` | Schedule grid of that weekday minus non-cancelled appointments; past slots excluded. |
| `fn_is_doctor_available(p_doctor_id int, p_start timestamptz, p_end timestamptz, p_exclude_appointment_id int DEFAULT NULL)` | `boolean` | In schedule + no overlap. |
| `fn_is_within_schedule(p_doctor_id int, p_start timestamptz, p_end timestamptz)` | `boolean` | Weekday, hours and slot grid only. |
| `fn_active_insurance(p_patient_id int, p_on date DEFAULT current_date)` | `patient_insurances` | Valid policy with max coverage (all-NULL row if none). |
| `fn_calc_stay_cost(p_admission_id int)` | `numeric` | days (min 1) × ward `daily_rate`. |
| `fn_department_occupancy(p_department_id int)` | `numeric` | % occupied beds. |
| `fn_patient_age(p_dob date, p_on date DEFAULT current_date)` | `int` | IMMUTABLE. |
| `fn_full_name(p_last text, p_first text, p_middle text)` | `text` | IMMUTABLE. |
| `fn_current_user_id()` | `int` | `app.current_user_id` or NULL. |
| `fn_assert_patient_active(p_patient_id int)` / `fn_assert_doctor_active(p_doctor_id int)` | `void` | Internal guards (`P0002` / `P0004` / `P0005`). |

## 3. Procedures

All write procedures run inside the caller's transaction (never COMMIT themselves).

| Signature | Effect | SQLSTATEs |
|---|---|---|
| `sp_user_create(p_email text, p_password_hash text, p_role user_role, p_full_name text, INOUT p_id int)` | email stored lower-case | P0409, 23514, 22P02 |
| `sp_user_set_active(p_id int, p_is_active boolean)` | | P0002, P0409 (self-deactivate) |
| `sp_user_touch_login(p_user_id int)` | `last_login_at = now()`; sets `app.current_user_id` to the user for the rest of the tx | P0002 |
| `sp_patient_create(p_last_name text, p_first_name text, p_middle_name text, p_birth_date date, p_sex sex_type, p_phone text, p_email text, p_address text, p_blood_type blood_type, p_emergency_contact_name text, p_emergency_contact_phone text, INOUT p_id int)` | | P0003, 23514 |
| `sp_patient_update(p_id int, …same 11 fields as create…)` | full replacement (PUT) | P0002, P0004, P0003, 23514 |
| `sp_patient_insurance_add(p_patient_id int, p_company_id int, p_policy_number text, p_coverage_percent numeric, p_valid_from date, p_valid_to date, INOUT p_id int)` | | P0002, P0004, P0409, 23514 (BR-10) |
| `sp_appointment_book(p_patient_id int, p_doctor_id int, p_start timestamptz, p_reason text, INOUT p_id int)` | duration = schedule `slot_minutes`; status `scheduled` | P0002, P0004, P0005, P0021, P0020, P0409, 23P01 |
| `sp_appointment_reschedule(p_id int, p_new_start timestamptz)` | | P0002, P0030, P0004, P0005, P0021, P0020, P0409, 23P01 |
| `sp_appointment_set_status(p_id int, p_status appointment_status)` | transitions: scheduled → confirmed/in_progress/completed/cancelled/no_show; confirmed → in_progress/completed/cancelled/no_show; in_progress → completed | P0002, P0031 |
| `sp_appointment_cancel(p_id int, p_reason text)` | status `cancelled`, frees the slot | P0002, P0031 |
| `sp_medical_record_create(p_appointment_id int, p_admission_id int, p_complaints text, p_examination text, p_conclusion text, p_recommendations text, INOUT p_id int)` | exactly one of appointment / admission; appointment → `completed` | P0040, P0002, P0409, P0041 |
| `sp_diagnosis_add(p_record_id int, p_icd10_code text, p_kind diagnosis_kind, p_notes text, INOUT p_id int)` | code upper-cased | P0002, P0042, P0409 |
| `sp_prescription_create(p_record_id int, p_valid_until date, p_items jsonb, INOUT p_id int)` | `p_items` = `JSON.stringify(PrescriptionItemInput[])` (camelCase keys: `medicationId, dosage, frequency, durationDays, quantity, instructions`) | P0002, P0043, P0044, P0045, 23514, 23502 |
| `sp_lab_order_create(p_patient_id int, p_doctor_id int, p_record_id int, p_priority lab_priority, p_test_codes text[], INOUT p_id int)` | codes case-insensitive; pass a JS string array | P0002, P0004, P0005, P0070, P0050 |
| `sp_lab_result_record(p_order_id int, p_test_type_id int, p_value_numeric numeric, p_value_text text, INOUT p_id int)` | `is_abnormal` by trigger; order → `in_progress`, → `completed` after the last test | P0002, P0051, P0052, P0053, P0409 |
| `sp_admit_patient(p_patient_id int, p_bed_id int, p_doctor_id int, p_reason text, INOUT p_id int)` | bed → `occupied` (trigger) | P0002, P0004, P0005, P0409, 23P01 |
| `sp_transfer_patient(p_admission_id int, p_new_bed_id int)` | old bed → `available`, new → `occupied` | P0002, P0060, P0061, P0409 |
| `sp_discharge_patient(p_admission_id int, p_summary text, INOUT p_invoice_id int)` | discharge + `sp_invoice_generate_for_admission` (invoice is **issued**) | P0002, P0060, P0409 |
| `sp_invoice_create(p_patient_id int, p_appointment_id int, p_admission_id int, INOUT p_id int)` | `draft`, number `INV-YYYY-000123`, coverage % from `fn_active_insurance` | P0002, P0070, P0409 |
| `sp_invoice_add_item(p_invoice_id int, p_item_type invoice_item_type, p_description text, p_quantity numeric, p_unit_price numeric, INOUT p_id int)` | totals recalculated by trigger | P0002, P0071, 23514 |
| `sp_invoice_generate_for_admission(p_admission_id int, INOUT p_invoice_id int)` | stay + lab tests in the period + consultations on the admission, then issue (14 days) | P0002, P0409 |
| `sp_invoice_issue(p_invoice_id int, p_due_days int DEFAULT 14)` | `draft → issued` (`paid` if total_due = 0) | P0002, P0072, P0074 |
| `sp_payment_register(p_invoice_id int, p_amount numeric, p_method payment_method, p_reference text, INOUT p_id int)` | status → `partially_paid` / `paid` (trigger) | P0002, P0073, P0075, P0076 |
| `sp_refresh_reports()` | `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_revenue` | — |
| `sp_soft_delete(p_table text, p_id int)` | `p_table` ∈ `SoftDeleteTable` | 22023, P0002, P0409 |
| `sp_restore(p_table text, p_id int)` | admin only | P0403, 22023, P0002, 23505 |

## 4. Views

| View | Columns (type) | Model |
|---|---|---|
| `v_users` | id int, email text, role user_role, full_name text, is_active boolean, last_login_at timestamptz, doctor_id int, patient_id int, created_at timestamptz, updated_at timestamptz, updated_by int, updated_by_email text | `User`, `CurrentUser` |
| `v_departments` | id int, name text, head_doctor_id int, head_doctor_name text | `Department` |
| `v_specializations` | id int, name text | `Specialization` |
| `v_insurance_companies` | id int, name text, phone text | `InsuranceCompany` |
| `v_icd10_codes` | code text, title text | `Icd10Code` |
| `v_medications` | id int, name text, form medication_form, strength text, unit_price numeric | `Medication` |
| `v_lab_test_types` | id int, code text, name text, unit text, ref_min numeric, ref_max numeric, price numeric | `LabTestType` |
| `v_patients` | id int, last_name text, first_name text, middle_name text, full_name text, birth_date date, age int, sex sex_type, phone text, email text, address text, blood_type blood_type, emergency_contact_name text, emergency_contact_phone text, insurance_company_name text, insurance_policy_number text, insurance_coverage_percent numeric(5,2), created_at timestamptz, updated_at timestamptz, updated_by int, updated_by_email text | `Patient` (non-deleted) |
| `v_patient_insurances` | id int, patient_id int, company_id int, company_name text, policy_number text, coverage_percent numeric(5,2), valid_from date, valid_to date, is_active boolean | `PatientInsurance` |
| `v_doctors` | id int, user_id int, full_name text, email text, phone text, department_id int, department_name text, specialization_id int, specialization_name text, license_number text, consultation_fee numeric | `Doctor` (non-deleted) |
| `v_doctor_schedule` | id int, doctor_id int, weekday int (ISO 1 = Mon), weekday_name text, start_time text 'HH:MM', end_time text, slot_minutes int, room text | `ScheduleEntry` |
| `v_appointments` | id int, patient_id int, patient_name text, doctor_id int, doctor_name text, department_id int, department_name text, specialization_name text, starts_at timestamptz, ends_at timestamptz, status appointment_status, reason text, cancel_reason text, room text, medical_record_id int, created_at timestamptz, updated_at timestamptz, updated_by int, updated_by_email text | `Appointment` |
| `v_today_appointments` | same as `v_appointments`, `starts_at` today, ordered by time | `Appointment` |
| `v_medical_records` | id int, patient_id int, patient_name text, doctor_id int, doctor_name text, appointment_id int, admission_id int, complaints text, examination text, conclusion text, recommendations text, diagnoses_summary text, diagnoses jsonb, created_at timestamptz | `MedicalRecord` |
| `v_diagnoses` | id int, medical_record_id int, icd10_code text, icd10_title text, kind diagnosis_kind, notes text | `Diagnosis` |
| `v_prescriptions` | id int, medical_record_id int, patient_id int, patient_name text, doctor_name text, issued_at timestamptz, valid_until date, items jsonb | `Prescription` |
| `v_lab_queue` | order_id int, patient_id int, patient_name text, doctor_name text, priority lab_priority, status lab_order_status, ordered_at timestamptz, test_type_id int, test_code text, test_name text, unit text, ref_min numeric, ref_max numeric | `LabQueueItem` (urgent first, then oldest) |
| `v_lab_results` | id int, order_id int, patient_id int, patient_name text, test_type_id int, test_code text, test_name text, value_numeric numeric, value_text text, unit text, ref_min numeric, ref_max numeric, is_abnormal boolean, recorded_at timestamptz, recorded_by_email text | `LabResult` |
| `v_beds` | id int, bed_number text, status bed_status, ward_id int, ward_number text, ward_type ward_type, daily_rate numeric, department_id int, department_name text, admission_id int, patient_id int, patient_name text | `Bed` |
| `v_admissions` | id int, patient_id int, patient_name text, bed_id int, bed_number text, ward_number text, department_name text, doctor_id int, doctor_name text, admitted_at timestamptz, discharged_at timestamptz, reason text, discharge_summary text, status admission_status, days int | `Admission` |
| `v_current_admissions` | same as `v_admissions`, `status = 'active'` | `Admission` |
| `v_bed_occupancy` | department_id int, department_name text, ward_id int, ward_number text, total_beds int, occupied_beds int, occupancy_percent numeric | `Occupancy` (`ward_id` NULL = department total) |
| `v_invoices` | id int, number text, patient_id int, patient_name text, appointment_id int, admission_id int, status invoice_status, subtotal numeric, insurance_coverage_percent numeric(5,2), insurance_amount numeric, total_due numeric, paid_amount numeric, balance numeric, issued_at timestamptz, due_date date, is_overdue boolean, created_at timestamptz | `Invoice` |
| `v_unpaid_invoices` | same as `v_invoices`, `issued`/`partially_paid` with balance > 0 | `Invoice` |
| `v_invoice_items` | id int, invoice_id int, item_type invoice_item_type, description text, quantity numeric(10,2), unit_price numeric, amount numeric(12,2) | `InvoiceItem` |
| `v_payments` | id int, invoice_id int, amount numeric, method payment_method, reference text, paid_at timestamptz, received_by_email text | `Payment` |
| `v_audit_log` | id int, table_name text, record_id int, operation audit_operation, changed_fields text[], old_data jsonb, new_data jsonb, changed_at timestamptz, changed_by int, changed_by_email text | `AuditEntry` |
| `v_deleted_records` | table_name text, record_id int, label text, deleted_at timestamptz, deleted_by int, deleted_by_email text | `DeletedRecord` |
| `mv_monthly_revenue` | month date, department_name text, method payment_method, payments_count int, total numeric(14,2) | `RevenueRow` (refresh via `sp_refresh_reports`) |

## 5. Route → SQL object

| Route (`routes.ts`) | SQL |
|---|---|
| `login` | `SELECT * FROM fn_auth_user($1)` → bcrypt compare → `CALL sp_user_touch_login($id)` |
| `me` | `v_users WHERE id = $1` |
| `listUsers` / `createUser` / `setUserActive` | `v_users` / `sp_user_create` / `sp_user_set_active` |
| `listDepartments` / `listSpecializations` / `listInsuranceCompanies` | `v_departments` / `v_specializations` / `v_insurance_companies` |
| `searchIcd10` / `searchMedications` / `listLabTestTypes` | `v_icd10_codes` / `v_medications` (`ILIKE`) / `v_lab_test_types` |
| `searchPatients` | `SELECT * FROM fn_search_patients($q, $limit)` |
| `getPatient` / `updatePatient` | `v_patients` / `sp_patient_update` then `v_patients` |
| `createPatient` / `deletePatient` | `sp_patient_create` / `sp_soft_delete('patients', id)` |
| `patientHistory` | `SELECT * FROM fn_patient_history($id)` |
| `patientInsurances` / `addInsurance` | `v_patient_insurances WHERE patient_id` / `sp_patient_insurance_add` |
| `register` | `sp_patient_create` → `sp_patient_insurance_add` → `sp_appointment_book` (one UoW) |
| `listDoctors` / `getDoctor` | `v_doctors` (filters `department_id`, `specialization_id`) |
| `doctorSchedule` / `freeSlots` | `v_doctor_schedule WHERE doctor_id ORDER BY weekday` / `fn_doctor_free_slots($id, $date)` |
| `listAppointments` / `getAppointment` | `v_appointments` (`date`: `starts_at >= $d::date AND starts_at < $d::date + 1`) |
| `todayAppointments` | `v_today_appointments` (filters `doctor_id`, `department_id`) |
| `bookAppointment` / `rescheduleAppointment` | `sp_appointment_book` / `sp_appointment_reschedule` |
| `setAppointmentStatus` / `cancelAppointment` | `sp_appointment_set_status` / `sp_appointment_cancel` |
| `completeVisit` | ids from `v_appointments` → `sp_medical_record_create(appt, NULL, …)` → `sp_diagnosis_add` ×N → `sp_prescription_create` → `sp_lab_order_create` → `sp_invoice_create(patient, appt, NULL)` → `sp_invoice_add_item('consultation', …, v_doctors.consultation_fee)` → `sp_invoice_issue` |
| `listMedicalRecords` / `getMedicalRecord` / `addDiagnosis` | `v_medical_records` / `sp_diagnosis_add` |
| `listPrescriptions` | `v_prescriptions WHERE patient_id` |
| `labQueue` / `createLabOrder` | `v_lab_queue` / `sp_lab_order_create` |
| `labOrderResults` / `patientLabResults` | `v_lab_results WHERE order_id` / `WHERE patient_id` |
| `recordLabResult` | `sp_lab_result_record` → `v_lab_results WHERE id = p_id` |
| `listBeds` / `occupancy` / `currentAdmissions` | `v_beds` / `v_bed_occupancy` / `v_current_admissions` |
| `admit` / `transfer` / `discharge` | `sp_admit_patient` / `sp_transfer_patient` / `sp_discharge_patient` → `{ p_invoice_id }` |
| `listInvoices` | `v_invoices` (or `v_unpaid_invoices` when `unpaidOnly`) |
| `getInvoice` | `v_invoices` + `v_invoice_items WHERE invoice_id` + `v_payments WHERE invoice_id` |
| `createInvoice` / `addInvoiceItem` / `issueInvoice` / `registerPayment` | `sp_invoice_create` / `sp_invoice_add_item` / `sp_invoice_issue` / `sp_payment_register` |
| `revenue` / `refreshReports` | `mv_monthly_revenue` (`month` between `date_trunc('month', from)` and `to`) / `sp_refresh_reports` |
| `auditLog` / `deletedRecords` | `v_audit_log` / `v_deleted_records` |
| `softDelete` / `restore` | `sp_soft_delete($table, $id)` / `sp_restore($table, $id)` |

## 6. Programmatic API (`import { … } from '@clinic/db'`)

`databaseUrl()`, `withDatabase(url, name)`, `ensureDatabase(url)`, `migrate(url)`, `seed(url, { volume })`,
`resetDatabase(url, { volume })` — e.g. API tests: `await resetDatabase('postgres://clinic:clinic@localhost:5434/clinic_api_test', { volume: false })`.

## Лаб 2 — міграція 009 (`009_lab2_tables.sql`)

Модель графа у термінах SQL (docs/06 §4, golden fixture: `packages/graph/fixtures/golden/`).

| Об'єкт | Тип | Призначення |
|---|---|---|
| `rooms`, `beds.room_id` | таблиця, колонка | кімната ліжка; складений FK `(room_id, ward_id)` гарантує ту саму палату; `trg_beds_default_room` дає ліжку без кімнати першу кімнату палати |
| `staff`, `staff_shifts` | таблиці | персонал (`staff_role`: doctor / nurse, `doctor_id` для лікаря), зміни з `EXCLUDE` (BR-15) |
| `drug_classes`, `medication_classes`, `medication_interactions`, `drug_class_interactions` | таблиці | класи, належність, взаємодії (`interaction_severity`); пари впорядковані `a < b` (класи `a <= b`) |
| `graph_outbox` | таблиця | outbox PG → Neo4j; заповнюють тригери `trg_<table>_graph_outbox` у тій самій транзакції |
| `fn_epoch_ms(timestamptz)` | функція | час графа: epoch ms, `infinity` → `9e15` |
| `v_presence` | view | `(person_kind, person_id, place_kind, place_id, f, t, period, src, src_id)` — ребра `PRESENT`; фільтруйте `period && tstzrange($from, $to)` (GiST-індекси на кожному джерелі) |
| `v_takes` | view | `(rx_item_id, patient_id, medication_id, f, t)` — ребра `TAKES` |
| `v_graph_persons`, `v_graph_places` | view | вузли `:Person` / `:Place` з іменами |
| `v_medication_interactions`, `v_drug_class_interactions`, `v_drug_classes`, `v_medication_classes` | view | довідники взаємодій з назвами |
| `v_graph_counts` | view | очікувані кількості вузлів / ребер після повного ETL |
| `v_graph_sync_status` | view | `pending`, `oldest_pending_at`, `last_processed_at`, `lag_ms` (BR-11, F-45) |
| `v_staff`, `v_staff_shifts`, `v_rooms` | view | читання для API (F-38) |
| `fn_graph_outbox_claim(worker, limit = 500, lease = 30 s)` | функція | забрати пачку подій (`FOR UPDATE SKIP LOCKED`), у порядку `id` |
| `sp_graph_outbox_ack(ids bigint[], error text = NULL)` | процедура | успіх → `processed_at`; помилка → назад у чергу з `last_error` |
| `sp_graph_outbox_purge(older interval = 1 day)` | процедура | прибрати оброблені події |
| `sp_staff_shift_add(staff_id, ward_id, starts_at, ends_at, INOUT id)` | процедура | додати зміну; перетин → `23P01` (409) |

Payload подій `graph_outbox` (`entity` → `payload`):

| entity | entity_key | payload |
|---|---|---|
| `patient` / `staff` | id | `{id, name}` / `{id, name, role}` |
| `ward` / `room` / `office` | id | `{id, name, departmentId, type}` / `{id, name, wardId}` / `{id, departmentId}` |
| `presence` | `admission:17`, `shift:5`, `appointment:9` | `{src, srcId, edges: [{personKind, personId, placeKind, placeId, f, t}]}` — **усі** ребра джерела; порожній масив = видалити |
| `takes` | rx item id | `{rxItemId, patientId, medicationId, f, t}` |
| `medication` / `drug_class` | id | `{id, name}` / `{id, code, name}` |
| `medication_class` | medication id | `{medicationId, classIds: [...]}` — повний набір класів препарату |
| `medication_interaction` / `class_interaction` | `a:b` | `{a, b, severity}`; `op = 'delete'` — пару видалено |

Масове завантаження без подій: `SET session_replication_role = replica` (тригери вимкнено) → повний ETL.
Повний ETL у знімку `REPEATABLE READ` має підтвердити (`sp_graph_outbox_ack`) усі події з `id <=` максимального id, видимого в знімку.
