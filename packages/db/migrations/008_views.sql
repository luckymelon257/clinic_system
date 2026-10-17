-- 008: view / materialized view (docs/02-sql-objects.md §5) + fn_search_patients, sp_refresh_reports
-- Назви колонок = snake_case полів моделей packages/contracts/src/models.ts.
-- Вкладені масиви — jsonb з camelCase-ключами вкладеної моделі.

-- ---------- користувачі та довідники ----------
CREATE VIEW v_users AS
SELECT u.id, u.email, r.code AS role, u.full_name, u.is_active, u.last_login_at,
       d.id AS doctor_id, p.id AS patient_id,
       u.created_at, u.updated_at, u.updated_by, ub.email AS updated_by_email
FROM users u
JOIN roles r ON r.id = u.role_id
LEFT JOIN doctors d ON d.user_id = u.id AND d.deleted_at IS NULL
LEFT JOIN patients p ON p.user_id = u.id AND p.deleted_at IS NULL
LEFT JOIN users ub ON ub.id = u.updated_by
WHERE u.deleted_at IS NULL;

CREATE VIEW v_departments AS
SELECT dep.id, dep.name, dep.head_doctor_id, hu.full_name AS head_doctor_name
FROM departments dep
LEFT JOIN doctors hd ON hd.id = dep.head_doctor_id
LEFT JOIN users hu ON hu.id = hd.user_id
WHERE dep.deleted_at IS NULL;

CREATE VIEW v_specializations AS
SELECT id, name FROM specializations;

CREATE VIEW v_insurance_companies AS
SELECT id, name, phone::text AS phone FROM insurance_companies WHERE deleted_at IS NULL;

CREATE VIEW v_icd10_codes AS
SELECT code, title FROM icd10_codes;

CREATE VIEW v_medications AS
SELECT id, name, form, strength, unit_price::numeric AS unit_price FROM medications WHERE deleted_at IS NULL;

CREATE VIEW v_lab_test_types AS
SELECT id, code, name, unit, ref_min, ref_max, price::numeric AS price FROM lab_test_types;

-- ---------- пацієнти ----------
CREATE VIEW v_patients AS
SELECT p.id, p.last_name, p.first_name, p.middle_name,
       fn_full_name(p.last_name, p.first_name, p.middle_name) AS full_name,
       p.birth_date, fn_patient_age(p.birth_date) AS age, p.sex,
       p.phone::text AS phone, p.email, p.address, p.blood_type,
       p.emergency_contact_name, p.emergency_contact_phone::text AS emergency_contact_phone,
       ic.name AS insurance_company_name, ai.policy_number AS insurance_policy_number,
       ai.coverage_percent AS insurance_coverage_percent,
       p.created_at, p.updated_at, p.updated_by, ub.email AS updated_by_email
FROM patients p
LEFT JOIN LATERAL fn_active_insurance(p.id) ai ON true
LEFT JOIN insurance_companies ic ON ic.id = ai.company_id
LEFT JOIN users ub ON ub.id = p.updated_by
WHERE p.deleted_at IS NULL;

CREATE VIEW v_patient_insurances AS
SELECT pi.id, pi.patient_id, pi.company_id, c.name AS company_name, pi.policy_number, pi.coverage_percent,
       pi.valid_from, pi.valid_to,
       (pi.valid_from <= current_date AND (pi.valid_to IS NULL OR pi.valid_to >= current_date)
         AND c.deleted_at IS NULL) AS is_active
FROM patient_insurances pi
JOIN insurance_companies c ON c.id = pi.company_id;

-- ---------- лікарі ----------
CREATE VIEW v_doctors AS
SELECT d.id, d.user_id, u.full_name, u.email, d.phone::text AS phone,
       d.department_id, dep.name AS department_name,
       d.specialization_id, s.name AS specialization_name,
       d.license_number, d.consultation_fee::numeric AS consultation_fee
FROM doctors d
JOIN users u ON u.id = d.user_id
JOIN departments dep ON dep.id = d.department_id
JOIN specializations s ON s.id = d.specialization_id
WHERE d.deleted_at IS NULL;

CREATE VIEW v_doctor_schedule AS
SELECT s.id, s.doctor_id, s.weekday::int AS weekday,
       (ARRAY['Понеділок', 'Вівторок', 'Середа', 'Четвер', 'Пʼятниця', 'Субота', 'Неділя'])[s.weekday] AS weekday_name,
       to_char(s.start_time, 'HH24:MI') AS start_time, to_char(s.end_time, 'HH24:MI') AS end_time,
       s.slot_minutes, s.room
FROM doctor_schedules s;

-- ---------- прийоми ----------
CREATE VIEW v_appointments AS
SELECT a.id, a.patient_id, fn_full_name(p.last_name, p.first_name, p.middle_name) AS patient_name,
       a.doctor_id, u.full_name AS doctor_name,
       d.department_id, dep.name AS department_name, s.name AS specialization_name,
       a.starts_at, a.ends_at, a.status, a.reason, a.cancel_reason,
       ds.room, mr.id AS medical_record_id,
       a.created_at, a.updated_at, a.updated_by, ub.email AS updated_by_email
FROM appointments a
JOIN patients p ON p.id = a.patient_id
JOIN doctors d ON d.id = a.doctor_id
JOIN users u ON u.id = d.user_id
JOIN departments dep ON dep.id = d.department_id
JOIN specializations s ON s.id = d.specialization_id
LEFT JOIN doctor_schedules ds ON ds.doctor_id = a.doctor_id AND ds.weekday = extract(isodow FROM a.starts_at)
LEFT JOIN medical_records mr ON mr.appointment_id = a.id
LEFT JOIN users ub ON ub.id = a.updated_by;

CREATE VIEW v_today_appointments AS
SELECT * FROM v_appointments
WHERE starts_at >= current_date::timestamptz AND starts_at < (current_date + 1)::timestamptz
ORDER BY starts_at;

-- ---------- медичні записи ----------
CREATE VIEW v_diagnoses AS
SELECT dg.id, dg.medical_record_id, dg.icd10_code, ic.title AS icd10_title, dg.kind, dg.notes
FROM diagnoses dg
JOIN icd10_codes ic ON ic.code = dg.icd10_code;

CREATE VIEW v_medical_records AS
SELECT mr.id, mr.patient_id, fn_full_name(p.last_name, p.first_name, p.middle_name) AS patient_name,
       mr.doctor_id, u.full_name AS doctor_name, mr.appointment_id, mr.admission_id,
       mr.complaints, mr.examination, mr.conclusion, mr.recommendations,
       dx.diagnoses_summary, coalesce(dx.diagnoses, '[]'::jsonb) AS diagnoses,
       mr.created_at
FROM medical_records mr
JOIN patients p ON p.id = mr.patient_id
JOIN doctors d ON d.id = mr.doctor_id
JOIN users u ON u.id = d.user_id
LEFT JOIN LATERAL (
  SELECT string_agg(v.icd10_code || ' ' || v.icd10_title, '; ' ORDER BY v.kind, v.icd10_code) AS diagnoses_summary,
         jsonb_agg(jsonb_build_object(
           'id', v.id, 'medicalRecordId', v.medical_record_id, 'icd10Code', v.icd10_code,
           'icd10Title', v.icd10_title, 'kind', v.kind, 'notes', v.notes) ORDER BY v.kind, v.icd10_code) AS diagnoses
  FROM v_diagnoses v
  WHERE v.medical_record_id = mr.id
) dx ON true;

CREATE VIEW v_prescriptions AS
SELECT pr.id, pr.medical_record_id, mr.patient_id,
       fn_full_name(p.last_name, p.first_name, p.middle_name) AS patient_name,
       u.full_name AS doctor_name, pr.issued_at, pr.valid_until,
       coalesce(it.items, '[]'::jsonb) AS items
FROM prescriptions pr
JOIN medical_records mr ON mr.id = pr.medical_record_id
JOIN patients p ON p.id = mr.patient_id
JOIN doctors d ON d.id = mr.doctor_id
JOIN users u ON u.id = d.user_id
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object(
           'medicationId', pi.medication_id,
           'medicationName', m.name || coalesce(' ' || m.strength, ''),
           'dosage', pi.dosage, 'frequency', pi.frequency, 'durationDays', pi.duration_days,
           'quantity', pi.quantity, 'instructions', pi.instructions) ORDER BY pi.id) AS items
  FROM prescription_items pi
  JOIN medications m ON m.id = pi.medication_id
  WHERE pi.prescription_id = pr.id
) it ON true;

-- ---------- лабораторія ----------
-- Тести без результату у незавершених направленнях: термінові першими, далі за часом
CREATE VIEW v_lab_queue AS
SELECT lo.id AS order_id, lo.patient_id, fn_full_name(p.last_name, p.first_name, p.middle_name) AS patient_name,
       u.full_name AS doctor_name, lo.priority, lo.status, lo.ordered_at,
       t.id AS test_type_id, t.code AS test_code, t.name AS test_name, t.unit, t.ref_min, t.ref_max
FROM lab_orders lo
JOIN lab_order_items li ON li.lab_order_id = lo.id
JOIN lab_test_types t ON t.id = li.test_type_id
JOIN patients p ON p.id = lo.patient_id
JOIN doctors d ON d.id = lo.doctor_id
JOIN users u ON u.id = d.user_id
WHERE lo.status IN ('ordered', 'in_progress')
  AND NOT EXISTS (SELECT 1 FROM lab_results r WHERE r.lab_order_id = lo.id AND r.test_type_id = li.test_type_id)
ORDER BY lo.priority DESC, lo.ordered_at, lo.id, t.code;

CREATE VIEW v_lab_results AS
SELECT r.id, r.lab_order_id AS order_id, lo.patient_id,
       fn_full_name(p.last_name, p.first_name, p.middle_name) AS patient_name,
       r.test_type_id, t.code AS test_code, t.name AS test_name, r.value_numeric, r.value_text,
       t.unit, t.ref_min, t.ref_max, r.is_abnormal, r.recorded_at, ub.email AS recorded_by_email
FROM lab_results r
JOIN lab_orders lo ON lo.id = r.lab_order_id
JOIN patients p ON p.id = lo.patient_id
JOIN lab_test_types t ON t.id = r.test_type_id
LEFT JOIN users ub ON ub.id = r.created_by;

-- ---------- стаціонар ----------
CREATE VIEW v_beds AS
SELECT b.id, b.bed_number, b.status, w.id AS ward_id, w.ward_number, w.ward_type, w.daily_rate::numeric AS daily_rate,
       dep.id AS department_id, dep.name AS department_name,
       a.id AS admission_id, a.patient_id, fn_full_name(p.last_name, p.first_name, p.middle_name) AS patient_name
FROM beds b
JOIN wards w ON w.id = b.ward_id
JOIN departments dep ON dep.id = w.department_id
LEFT JOIN admissions a ON a.bed_id = b.id AND a.status = 'active'
LEFT JOIN patients p ON p.id = a.patient_id
WHERE b.deleted_at IS NULL AND w.deleted_at IS NULL;

CREATE VIEW v_admissions AS
SELECT a.id, a.patient_id, fn_full_name(p.last_name, p.first_name, p.middle_name) AS patient_name,
       a.bed_id, b.bed_number, w.ward_number, dep.name AS department_name,
       a.doctor_id, u.full_name AS doctor_name, a.admitted_at, a.discharged_at, a.reason, a.discharge_summary,
       a.status, greatest(1, coalesce(a.discharged_at, now())::date - a.admitted_at::date) AS days
FROM admissions a
JOIN patients p ON p.id = a.patient_id
JOIN beds b ON b.id = a.bed_id
JOIN wards w ON w.id = b.ward_id
JOIN departments dep ON dep.id = w.department_id
JOIN doctors d ON d.id = a.doctor_id
JOIN users u ON u.id = d.user_id;

CREATE VIEW v_current_admissions AS
SELECT * FROM v_admissions WHERE status = 'active' ORDER BY admitted_at;

-- Рядки по палатах + підсумковий рядок відділення (ward_id IS NULL) через GROUPING SETS
CREATE VIEW v_bed_occupancy AS
SELECT dep.id AS department_id, dep.name AS department_name, w.id AS ward_id, w.ward_number,
       count(b.id)::int AS total_beds,
       (count(b.id) FILTER (WHERE b.status = 'occupied'))::int AS occupied_beds,
       coalesce(round(100.0 * count(b.id) FILTER (WHERE b.status = 'occupied') / nullif(count(b.id), 0), 2), 0)
         AS occupancy_percent
FROM departments dep
JOIN wards w ON w.department_id = dep.id AND w.deleted_at IS NULL
LEFT JOIN beds b ON b.ward_id = w.id AND b.deleted_at IS NULL
WHERE dep.deleted_at IS NULL
GROUP BY GROUPING SETS ((dep.id, dep.name, w.id, w.ward_number), (dep.id, dep.name))
ORDER BY dep.name, w.ward_number NULLS FIRST;

-- ---------- фінанси ----------
CREATE VIEW v_invoices AS
SELECT i.id, i.number, i.patient_id, fn_full_name(p.last_name, p.first_name, p.middle_name) AS patient_name,
       i.appointment_id, i.admission_id, i.status,
       i.subtotal::numeric AS subtotal, i.insurance_coverage_percent, i.insurance_amount::numeric AS insurance_amount,
       i.total_due::numeric AS total_due, i.paid_amount::numeric AS paid_amount,
       (i.total_due - i.paid_amount)::numeric AS balance,
       i.issued_at, i.due_date,
       (i.status IN ('issued', 'partially_paid') AND i.due_date < current_date AND i.total_due > i.paid_amount) AS is_overdue,
       i.created_at
FROM invoices i
JOIN patients p ON p.id = i.patient_id;

CREATE VIEW v_unpaid_invoices AS
SELECT * FROM v_invoices WHERE status IN ('issued', 'partially_paid') AND balance > 0;

CREATE VIEW v_invoice_items AS
SELECT id, invoice_id, item_type, description, quantity, unit_price::numeric AS unit_price, amount
FROM invoice_items;

CREATE VIEW v_payments AS
SELECT pm.id, pm.invoice_id, pm.amount::numeric AS amount, pm.method, pm.reference, pm.paid_at,
       u.email AS received_by_email
FROM payments pm
LEFT JOIN users u ON u.id = pm.created_by;

-- ---------- аудит / адміністрування ----------
CREATE VIEW v_audit_log AS
SELECT l.id, l.table_name, l.record_id, l.operation, l.changed_fields, l.old_data, l.new_data,
       l.changed_at, l.changed_by, u.email AS changed_by_email
FROM audit_log l
LEFT JOIN users u ON u.id = l.changed_by;

CREATE VIEW v_deleted_records AS
SELECT x.table_name, x.record_id, x.label, x.deleted_at, x.deleted_by, u.email AS deleted_by_email
FROM (
  SELECT 'users'::text AS table_name, id AS record_id, email || ' (' || full_name || ')' AS label, deleted_at, deleted_by
  FROM users WHERE deleted_at IS NOT NULL
  UNION ALL
  SELECT 'patients', id, fn_full_name(last_name, first_name, middle_name) || ', ' || to_char(birth_date, 'DD.MM.YYYY'),
         deleted_at, deleted_by
  FROM patients WHERE deleted_at IS NOT NULL
  UNION ALL
  SELECT 'doctors', d.id, u.full_name || ' (ліцензія ' || d.license_number || ')', d.deleted_at, d.deleted_by
  FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.deleted_at IS NOT NULL
  UNION ALL
  SELECT 'departments', id, name, deleted_at, deleted_by FROM departments WHERE deleted_at IS NOT NULL
  UNION ALL
  SELECT 'wards', id, 'Палата ' || ward_number, deleted_at, deleted_by FROM wards WHERE deleted_at IS NOT NULL
  UNION ALL
  SELECT 'beds', b.id, 'Палата ' || w.ward_number || ', ліжко ' || b.bed_number, b.deleted_at, b.deleted_by
  FROM beds b JOIN wards w ON w.id = b.ward_id WHERE b.deleted_at IS NOT NULL
  UNION ALL
  SELECT 'medications', id, name || coalesce(' ' || strength, ''), deleted_at, deleted_by
  FROM medications WHERE deleted_at IS NOT NULL
  UNION ALL
  SELECT 'insurance_companies', id, name, deleted_at, deleted_by FROM insurance_companies WHERE deleted_at IS NOT NULL
) x
LEFT JOIN users u ON u.id = x.deleted_by;

-- ---------- звіти ----------
-- Виручка по місяцях × відділеннях × способах оплати. Відділення: лікар прийому або палата госпіталізації.
CREATE MATERIALIZED VIEW mv_monthly_revenue AS
SELECT date_trunc('month', pm.paid_at)::date AS month,
       coalesce(dep_a.name, dep_h.name, 'Без відділення') AS department_name,
       pm.method,
       count(*)::int AS payments_count,
       sum(pm.amount)::numeric(14, 2) AS total
FROM payments pm
JOIN invoices i ON i.id = pm.invoice_id
LEFT JOIN appointments a ON a.id = i.appointment_id
LEFT JOIN doctors d ON d.id = a.doctor_id
LEFT JOIN departments dep_a ON dep_a.id = d.department_id
LEFT JOIN admissions ad ON ad.id = i.admission_id
LEFT JOIN beds b ON b.id = ad.bed_id
LEFT JOIN wards w ON w.id = b.ward_id
LEFT JOIN departments dep_h ON dep_h.id = w.department_id
GROUP BY 1, 2, 3;

CREATE UNIQUE INDEX ux_mv_monthly_revenue ON mv_monthly_revenue (month, department_name, method);

CREATE PROCEDURE sp_refresh_reports()
LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_revenue;
END $$;

-- ---------- пошук ----------
-- Нечіткий пошук за ПІБ (trgm: similarity / ILIKE по ix_patients_fullname_trgm) і телефоном.
-- Порожній запит → нещодавно змінені пацієнти.
CREATE FUNCTION fn_search_patients(p_query text, p_limit int DEFAULT 20) RETURNS SETOF v_patients
LANGUAGE sql STABLE AS $$
  WITH q AS (
    SELECT btrim(coalesce(p_query, '')) AS text,
           regexp_replace(coalesce(p_query, ''), '\D', '', 'g') AS digits
  ), hits AS (
    SELECT p.id,
           CASE WHEN q.text = '' THEN 0
                ELSE similarity(p.last_name || ' ' || p.first_name, q.text) END AS score,
           coalesce(p.updated_at, p.created_at) AS touched_at
    FROM patients p, q
    WHERE p.deleted_at IS NULL
      AND (q.text = ''
           OR (p.last_name || ' ' || p.first_name) % q.text
           OR (p.last_name || ' ' || p.first_name) ILIKE '%' || q.text || '%'
           OR (length(q.digits) >= 3 AND regexp_replace(p.phone::text, '\D', '', 'g') LIKE '%' || q.digits || '%'))
    ORDER BY score DESC, touched_at DESC, p.id DESC
    LIMIT greatest(coalesce(p_limit, 20), 1)
  )
  SELECT v.*
  FROM hits h
  JOIN v_patients v ON v.id = h.id
  ORDER BY h.score DESC, h.touched_at DESC, h.id DESC
$$;
