-- 003: індекси (docs/02-sql-objects.md §6)
-- Unique-індекси з UNIQUE-обмежень (ux_beds_ward_number, ux_lab_test_types_code, PK icd10_codes ...) та
-- GiST-індекси EXCLUDE-обмежень (ex_appointments_doctor_overlap, ex_admissions_bed_active) створені у 002.

-- B-tree
CREATE INDEX ix_appointments_doctor_start ON appointments (doctor_id, starts_at);
CREATE INDEX ix_appointments_starts_at ON appointments (starts_at);
CREATE INDEX ix_doctors_department ON doctors (department_id);
CREATE INDEX ix_doctors_specialization ON doctors (specialization_id);
CREATE INDEX ix_patient_insurances_patient ON patient_insurances (patient_id, valid_from);
CREATE INDEX ix_medical_records_patient ON medical_records (patient_id, created_at);
CREATE INDEX ix_medical_records_admission ON medical_records (admission_id);
CREATE INDEX ix_diagnoses_record ON diagnoses (medical_record_id);
CREATE INDEX ix_prescriptions_record ON prescriptions (medical_record_id);
CREATE INDEX ix_prescription_items_prescription ON prescription_items (prescription_id);
CREATE INDEX ix_lab_orders_patient ON lab_orders (patient_id, ordered_at);
CREATE INDEX ix_lab_results_order ON lab_results (lab_order_id);
CREATE INDEX ix_admissions_patient ON admissions (patient_id);
CREATE INDEX ix_admissions_bed ON admissions (bed_id);
CREATE INDEX ix_wards_department ON wards (department_id);
CREATE INDEX ix_invoices_patient ON invoices (patient_id);
CREATE INDEX ix_invoices_appointment ON invoices (appointment_id);
CREATE INDEX ix_invoices_admission ON invoices (admission_id);
CREATE INDEX ix_invoice_items_invoice ON invoice_items (invoice_id);
CREATE INDEX ix_payments_invoice ON payments (invoice_id);
CREATE INDEX ix_audit_table_record ON audit_log (table_name, record_id);

-- Partial unique + expression (BR-8): email унікальний без урахування регістру серед не видалених
CREATE UNIQUE INDEX ux_users_email_active ON users (lower(email)) WHERE deleted_at IS NULL;
-- Partial unique: в одному медичному записі лише один основний діагноз
CREATE UNIQUE INDEX ux_diagnoses_primary ON diagnoses (medical_record_id) WHERE kind = 'primary';
-- Partial unique: у пацієнта не більше однієї активної госпіталізації
CREATE UNIQUE INDEX ux_admissions_patient_active ON admissions (patient_id) WHERE status = 'active';

-- Partial
CREATE INDEX ix_beds_available ON beds (ward_id) WHERE status = 'available';
CREATE INDEX ix_invoices_unpaid ON invoices (due_date) WHERE status IN ('issued', 'partially_paid');
CREATE INDEX ix_lab_orders_pending ON lab_orders (priority, ordered_at) WHERE status IN ('ordered', 'in_progress');

-- Expression: пошук без урахування регістру
CREATE INDEX ix_patients_email_lower ON patients (lower(email));

-- GIN (pg_trgm): нечіткий пошук за ПІБ і телефоном
CREATE INDEX ix_patients_fullname_trgm ON patients USING gin ((last_name || ' ' || first_name) gin_trgm_ops);
CREATE INDEX ix_patients_phone_trgm ON patients USING gin ((regexp_replace(phone::text, '\D', '', 'g')) gin_trgm_ops);

-- GIN (jsonb_path_ops): пошук у журналі за значенням поля (new_data @> '{...}')
CREATE INDEX ix_audit_new_data ON audit_log USING gin (new_data jsonb_path_ops);

-- BRIN: великі хронологічні таблиці
CREATE INDEX ix_audit_changed_at ON audit_log USING brin (changed_at);
CREATE INDEX ix_payments_paid_at ON payments USING brin (paid_at);

-- Covering: index-only scan для історії пацієнта
CREATE INDEX ix_appointments_patient ON appointments (patient_id) INCLUDE (starts_at, status);
