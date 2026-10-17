-- 006: збережені процедури — усі операції запису з коду (docs/02-sql-objects.md §3)
-- Id створеного запису повертається через останній INOUT-параметр: CALL sp_x($1, $2, NULL) → рядок { p_id }.
-- Помилки: P0002 не знайдено, P0403 заборонено, P0409 конфлікт, інші P0xxx — порушення бізнес-правил (див. SQL_API.md).

-- ---------- допоміжні перевірки (BR-4) ----------
CREATE FUNCTION fn_assert_patient_active(p_patient_id int) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_deleted timestamptz;
BEGIN
  SELECT deleted_at INTO v_deleted FROM patients WHERE id = p_patient_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Пацієнта #% не знайдено', p_patient_id USING ERRCODE = 'P0002';
  END IF;
  IF v_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'Пацієнта #% видалено — операція неможлива', p_patient_id USING ERRCODE = 'P0004';
  END IF;
END $$;

CREATE FUNCTION fn_assert_doctor_active(p_doctor_id int) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_deleted timestamptz;
BEGIN
  SELECT deleted_at INTO v_deleted FROM doctors WHERE id = p_doctor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Лікаря #% не знайдено', p_doctor_id USING ERRCODE = 'P0002';
  END IF;
  IF v_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'Лікаря #% видалено — операція неможлива', p_doctor_id USING ERRCODE = 'P0005';
  END IF;
END $$;

-- ---------- користувачі ----------
-- p_password_hash — bcrypt-хеш, обчислений у коді (bcryptjs)
CREATE PROCEDURE sp_user_create(p_email text, p_password_hash text, p_role user_role, p_full_name text,
                                INOUT p_id int DEFAULT NULL)
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(btrim(p_email)) AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Користувач з email % вже існує', p_email USING ERRCODE = 'P0409';
  END IF;
  INSERT INTO users (email, password_hash, role_id, full_name)
  VALUES (lower(btrim(p_email)), p_password_hash, (SELECT id FROM roles WHERE code = p_role), btrim(p_full_name))
  RETURNING id INTO p_id;
END $$;

CREATE PROCEDURE sp_user_set_active(p_id int, p_is_active boolean)
LANGUAGE plpgsql AS $$
BEGIN
  IF p_id = fn_current_user_id() AND NOT p_is_active THEN
    RAISE EXCEPTION 'Не можна деактивувати власний обліковий запис' USING ERRCODE = 'P0409';
  END IF;
  UPDATE users SET is_active = p_is_active WHERE id = p_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Користувача #% не знайдено', p_id USING ERRCODE = 'P0002';
  END IF;
END $$;

-- Фіксує час входу; автором зміни вважається сам користувач
CREATE PROCEDURE sp_user_touch_login(p_user_id int)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.current_user_id', p_user_id::text, true);
  UPDATE users SET last_login_at = now() WHERE id = p_user_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Користувача #% не знайдено', p_user_id USING ERRCODE = 'P0002';
  END IF;
END $$;

-- ---------- пацієнти ----------
CREATE PROCEDURE sp_patient_create(
  p_last_name text, p_first_name text, p_middle_name text, p_birth_date date, p_sex sex_type,
  p_phone text, p_email text, p_address text, p_blood_type blood_type,
  p_emergency_contact_name text, p_emergency_contact_phone text,
  INOUT p_id int DEFAULT NULL)
LANGUAGE plpgsql AS $$
BEGIN
  IF p_birth_date > current_date THEN
    RAISE EXCEPTION 'Дата народження не може бути в майбутньому' USING ERRCODE = 'P0003';
  END IF;
  INSERT INTO patients (last_name, first_name, middle_name, birth_date, sex, phone, email, address, blood_type,
                        emergency_contact_name, emergency_contact_phone)
  VALUES (btrim(p_last_name), btrim(p_first_name), nullif(btrim(p_middle_name), ''), p_birth_date, p_sex, p_phone,
          lower(p_email), p_address, p_blood_type, p_emergency_contact_name, p_emergency_contact_phone)
  RETURNING id INTO p_id;
END $$;

CREATE PROCEDURE sp_patient_update(
  p_id int, p_last_name text, p_first_name text, p_middle_name text, p_birth_date date, p_sex sex_type,
  p_phone text, p_email text, p_address text, p_blood_type blood_type,
  p_emergency_contact_name text, p_emergency_contact_phone text)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fn_assert_patient_active(p_id);
  IF p_birth_date > current_date THEN
    RAISE EXCEPTION 'Дата народження не може бути в майбутньому' USING ERRCODE = 'P0003';
  END IF;
  UPDATE patients
  SET last_name = btrim(p_last_name), first_name = btrim(p_first_name), middle_name = nullif(btrim(p_middle_name), ''),
      birth_date = p_birth_date, sex = p_sex, phone = p_phone, email = lower(p_email), address = p_address,
      blood_type = p_blood_type, emergency_contact_name = p_emergency_contact_name,
      emergency_contact_phone = p_emergency_contact_phone
  WHERE id = p_id;
END $$;

CREATE PROCEDURE sp_patient_insurance_add(
  p_patient_id int, p_company_id int, p_policy_number text, p_coverage_percent numeric,
  p_valid_from date, p_valid_to date, INOUT p_id int DEFAULT NULL)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM fn_assert_patient_active(p_patient_id);
  IF NOT EXISTS (SELECT 1 FROM insurance_companies WHERE id = p_company_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Страхову компанію #% не знайдено', p_company_id USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM patient_insurances WHERE company_id = p_company_id AND policy_number = btrim(p_policy_number)) THEN
    RAISE EXCEPTION 'Поліс % цієї компанії вже зареєстровано', p_policy_number USING ERRCODE = 'P0409';
  END IF;
  -- BR-10 (0–100) і valid_to >= valid_from перевіряють CHECK-обмеження (23514)
  INSERT INTO patient_insurances (patient_id, company_id, policy_number, coverage_percent, valid_from, valid_to)
  VALUES (p_patient_id, p_company_id, btrim(p_policy_number), p_coverage_percent, p_valid_from, p_valid_to)
  RETURNING id INTO p_id;
END $$;

-- ---------- прийоми ----------
CREATE PROCEDURE sp_appointment_book(p_patient_id int, p_doctor_id int, p_start timestamptz, p_reason text,
                                     INOUT p_id int DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE
  v_slot int;
  v_end  timestamptz;
BEGIN
  PERFORM fn_assert_patient_active(p_patient_id); -- BR-4
  PERFORM fn_assert_doctor_active(p_doctor_id);   -- BR-4
  IF p_start < now() THEN
    RAISE EXCEPTION 'Не можна записати на час, що минув' USING ERRCODE = 'P0021';
  END IF;
  SELECT slot_minutes INTO v_slot
  FROM doctor_schedules WHERE doctor_id = p_doctor_id AND weekday = extract(isodow FROM p_start);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Лікар не працює у цей день' USING ERRCODE = 'P0020'; -- BR-3
  END IF;
  v_end := p_start + make_interval(mins => v_slot);
  IF NOT fn_is_doctor_available(p_doctor_id, p_start, v_end) THEN
    IF EXISTS (SELECT 1 FROM appointments a
               WHERE a.doctor_id = p_doctor_id AND a.status NOT IN ('cancelled', 'no_show')
                 AND tstzrange(a.starts_at, a.ends_at) && tstzrange(p_start, v_end)) THEN
      RAISE EXCEPTION 'Лікар уже має запис на цей час' USING ERRCODE = 'P0409'; -- BR-1
    END IF;
    RAISE EXCEPTION 'Час поза розкладом лікаря або не збігається з сіткою слотів' USING ERRCODE = 'P0020'; -- BR-3
  END IF;
  INSERT INTO appointments (patient_id, doctor_id, starts_at, ends_at, reason)
  VALUES (p_patient_id, p_doctor_id, p_start, v_end, p_reason)
  RETURNING id INTO p_id; -- гонка двох записів ловиться EXCLUDE (23P01)
END $$;

CREATE PROCEDURE sp_appointment_reschedule(p_id int, p_new_start timestamptz)
LANGUAGE plpgsql AS $$
DECLARE
  v_appt appointments;
  v_slot int;
  v_end  timestamptz;
BEGIN
  SELECT * INTO v_appt FROM appointments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Запис на прийом #% не знайдено', p_id USING ERRCODE = 'P0002';
  END IF;
  IF v_appt.status NOT IN ('scheduled', 'confirmed') THEN
    RAISE EXCEPTION 'Перенести можна лише запланований або підтверджений прийом (зараз: %)', v_appt.status
      USING ERRCODE = 'P0030';
  END IF;
  PERFORM fn_assert_patient_active(v_appt.patient_id);
  PERFORM fn_assert_doctor_active(v_appt.doctor_id);
  IF p_new_start < now() THEN
    RAISE EXCEPTION 'Не можна перенести на час, що минув' USING ERRCODE = 'P0021';
  END IF;
  SELECT slot_minutes INTO v_slot
  FROM doctor_schedules WHERE doctor_id = v_appt.doctor_id AND weekday = extract(isodow FROM p_new_start);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Лікар не працює у цей день' USING ERRCODE = 'P0020';
  END IF;
  v_end := p_new_start + make_interval(mins => v_slot);
  IF NOT fn_is_doctor_available(v_appt.doctor_id, p_new_start, v_end, p_id) THEN
    IF EXISTS (SELECT 1 FROM appointments a
               WHERE a.doctor_id = v_appt.doctor_id AND a.id <> p_id AND a.status NOT IN ('cancelled', 'no_show')
                 AND tstzrange(a.starts_at, a.ends_at) && tstzrange(p_new_start, v_end)) THEN
      RAISE EXCEPTION 'Лікар уже має запис на цей час' USING ERRCODE = 'P0409';
    END IF;
    RAISE EXCEPTION 'Час поза розкладом лікаря або не збігається з сіткою слотів' USING ERRCODE = 'P0020';
  END IF;
  UPDATE appointments SET starts_at = p_new_start, ends_at = v_end WHERE id = p_id;
END $$;

-- Допустимі переходи статусів перевіряє тригер trg_appointments_status_guard (P0031)
CREATE PROCEDURE sp_appointment_set_status(p_id int, p_status appointment_status)
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE appointments SET status = p_status WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Запис на прийом #% не знайдено', p_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE PROCEDURE sp_appointment_cancel(p_id int, p_reason text)
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE appointments SET status = 'cancelled', cancel_reason = p_reason WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Запис на прийом #% не знайдено', p_id USING ERRCODE = 'P0002';
  END IF;
END $$;

-- ---------- медичні записи ----------
-- Рівно одне з p_appointment_id / p_admission_id. Для прийому переводить його у completed.
CREATE PROCEDURE sp_medical_record_create(
  p_appointment_id int, p_admission_id int, p_complaints text, p_examination text, p_conclusion text,
  p_recommendations text, INOUT p_id int DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE
  v_patient int;
  v_doctor  int;
  v_status  appointment_status;
BEGIN
  IF num_nonnulls(p_appointment_id, p_admission_id) <> 1 THEN
    RAISE EXCEPTION 'Медичний запис створюється або для прийому, або для госпіталізації' USING ERRCODE = 'P0040';
  END IF;
  IF p_appointment_id IS NOT NULL THEN
    SELECT patient_id, doctor_id, status INTO v_patient, v_doctor, v_status
    FROM appointments WHERE id = p_appointment_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Запис на прийом #% не знайдено', p_appointment_id USING ERRCODE = 'P0002';
    END IF;
    IF EXISTS (SELECT 1 FROM medical_records WHERE appointment_id = p_appointment_id) THEN
      RAISE EXCEPTION 'Для цього прийому медичний запис уже створено' USING ERRCODE = 'P0409';
    END IF;
    IF v_status IN ('cancelled', 'no_show', 'completed') THEN
      RAISE EXCEPTION 'Неможливо провести прийом у статусі %', v_status USING ERRCODE = 'P0041';
    END IF;
  ELSE
    SELECT patient_id, doctor_id INTO v_patient, v_doctor FROM admissions WHERE id = p_admission_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Госпіталізацію #% не знайдено', p_admission_id USING ERRCODE = 'P0002';
    END IF;
  END IF;

  INSERT INTO medical_records (appointment_id, admission_id, patient_id, doctor_id, complaints, examination,
                               conclusion, recommendations)
  VALUES (p_appointment_id, p_admission_id, v_patient, v_doctor, p_complaints, p_examination, p_conclusion,
          p_recommendations)
  RETURNING id INTO p_id;

  IF p_appointment_id IS NOT NULL THEN
    UPDATE appointments SET status = 'completed' WHERE id = p_appointment_id;
  END IF;
END $$;

CREATE PROCEDURE sp_diagnosis_add(p_record_id int, p_icd10_code text, p_kind diagnosis_kind, p_notes text,
                                  INOUT p_id int DEFAULT NULL)
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM medical_records WHERE id = p_record_id) THEN
    RAISE EXCEPTION 'Медичний запис #% не знайдено', p_record_id USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM icd10_codes WHERE code = upper(btrim(p_icd10_code))) THEN
    RAISE EXCEPTION 'Невідомий код МКХ-10: %', p_icd10_code USING ERRCODE = 'P0042';
  END IF;
  IF p_kind = 'primary' AND EXISTS (SELECT 1 FROM diagnoses WHERE medical_record_id = p_record_id AND kind = 'primary') THEN
    RAISE EXCEPTION 'У медичному записі вже є основний діагноз' USING ERRCODE = 'P0409';
  END IF;
  IF EXISTS (SELECT 1 FROM diagnoses WHERE medical_record_id = p_record_id AND icd10_code = upper(btrim(p_icd10_code))) THEN
    RAISE EXCEPTION 'Діагноз % уже додано до запису', p_icd10_code USING ERRCODE = 'P0409';
  END IF;
  INSERT INTO diagnoses (medical_record_id, icd10_code, kind, notes)
  VALUES (p_record_id, upper(btrim(p_icd10_code)), p_kind, p_notes)
  RETURNING id INTO p_id;
END $$;

-- p_items: JSON-масив з camelCase-ключами (як PrescriptionItemInput у contracts):
-- [{"medicationId":1,"dosage":"500 мг","frequency":"2 рази на день","durationDays":7,"quantity":14,"instructions":null}]
CREATE PROCEDURE sp_prescription_create(p_record_id int, p_valid_until date, p_items jsonb, INOUT p_id int DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE
  v_bad int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM medical_records WHERE id = p_record_id) THEN
    RAISE EXCEPTION 'Медичний запис #% не знайдено', p_record_id USING ERRCODE = 'P0002';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Рецепт має містити хоча б одну позицію' USING ERRCODE = 'P0043';
  END IF;
  IF p_valid_until < current_date THEN
    RAISE EXCEPTION 'Термін дії рецепта не може бути в минулому' USING ERRCODE = 'P0045';
  END IF;
  SELECT x."medicationId" INTO v_bad
  FROM jsonb_to_recordset(p_items) AS x("medicationId" int)
  LEFT JOIN medications m ON m.id = x."medicationId" AND m.deleted_at IS NULL
  WHERE m.id IS NULL
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Препарат #% не знайдено або видалено', v_bad USING ERRCODE = 'P0044';
  END IF;

  INSERT INTO prescriptions (medical_record_id, valid_until) VALUES (p_record_id, p_valid_until)
  RETURNING id INTO p_id;
  INSERT INTO prescription_items (prescription_id, medication_id, dosage, frequency, duration_days, quantity, instructions)
  SELECT p_id, x."medicationId", x.dosage, x.frequency, x."durationDays", x.quantity, x.instructions
  FROM jsonb_to_recordset(p_items) AS x("medicationId" int, dosage text, frequency text, "durationDays" int,
                                        quantity int, instructions text);
END $$;

-- ---------- лабораторія ----------
CREATE PROCEDURE sp_lab_order_create(p_patient_id int, p_doctor_id int, p_record_id int, p_priority lab_priority,
                                     p_test_codes text[], INOUT p_id int DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE
  v_unknown text;
BEGIN
  PERFORM fn_assert_patient_active(p_patient_id);
  PERFORM fn_assert_doctor_active(p_doctor_id);
  IF p_record_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM medical_records WHERE id = p_record_id AND patient_id = p_patient_id) THEN
    RAISE EXCEPTION 'Медичний запис #% не належить пацієнту #%', p_record_id, p_patient_id USING ERRCODE = 'P0070';
  END IF;
  IF p_test_codes IS NULL OR cardinality(p_test_codes) = 0 THEN
    RAISE EXCEPTION 'Направлення має містити хоча б один аналіз' USING ERRCODE = 'P0050';
  END IF;
  SELECT string_agg(c, ', ') INTO v_unknown
  FROM unnest(p_test_codes) c
  WHERE NOT EXISTS (SELECT 1 FROM lab_test_types t WHERE t.code = upper(btrim(c)));
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'Невідомі коди аналізів: %', v_unknown USING ERRCODE = 'P0050';
  END IF;

  INSERT INTO lab_orders (patient_id, doctor_id, medical_record_id, priority)
  VALUES (p_patient_id, p_doctor_id, p_record_id, coalesce(p_priority, 'routine'))
  RETURNING id INTO p_id;
  INSERT INTO lab_order_items (lab_order_id, test_type_id)
  SELECT DISTINCT p_id, t.id FROM lab_test_types t WHERE t.code IN (SELECT upper(btrim(c)) FROM unnest(p_test_codes) c);
END $$;

-- Внесення результату; is_abnormal рахує тригер. Після останнього результату направлення стає completed.
CREATE PROCEDURE sp_lab_result_record(p_order_id int, p_test_type_id int, p_value_numeric numeric, p_value_text text,
                                      INOUT p_id int DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE
  v_status lab_order_status;
BEGIN
  SELECT status INTO v_status FROM lab_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Направлення #% не знайдено', p_order_id USING ERRCODE = 'P0002';
  END IF;
  IF v_status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'Направлення #% закрите (статус %)', p_order_id, v_status USING ERRCODE = 'P0051';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lab_order_items WHERE lab_order_id = p_order_id AND test_type_id = p_test_type_id) THEN
    RAISE EXCEPTION 'Аналіз #% не входить у направлення #%', p_test_type_id, p_order_id USING ERRCODE = 'P0052';
  END IF;
  IF EXISTS (SELECT 1 FROM lab_results WHERE lab_order_id = p_order_id AND test_type_id = p_test_type_id) THEN
    RAISE EXCEPTION 'Результат цього аналізу вже внесено' USING ERRCODE = 'P0409';
  END IF;
  IF p_value_numeric IS NULL AND nullif(btrim(p_value_text), '') IS NULL THEN
    RAISE EXCEPTION 'Вкажіть числове або текстове значення' USING ERRCODE = 'P0053';
  END IF;

  INSERT INTO lab_results (lab_order_id, test_type_id, value_numeric, value_text)
  VALUES (p_order_id, p_test_type_id, p_value_numeric, nullif(btrim(p_value_text), ''))
  RETURNING id INTO p_id;

  UPDATE lab_orders o
  SET status = s.status,
      completed_at = CASE WHEN s.status = 'completed' THEN now() END
  FROM (
    SELECT CASE WHEN NOT EXISTS (
                  SELECT 1 FROM lab_order_items i
                  WHERE i.lab_order_id = p_order_id
                    AND NOT EXISTS (SELECT 1 FROM lab_results r
                                    WHERE r.lab_order_id = i.lab_order_id AND r.test_type_id = i.test_type_id))
                THEN 'completed' ELSE 'in_progress' END::lab_order_status AS status
  ) s
  WHERE o.id = p_order_id;
END $$;

-- ---------- стаціонар ----------
CREATE PROCEDURE sp_admit_patient(p_patient_id int, p_bed_id int, p_doctor_id int, p_reason text,
                                  INOUT p_id int DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE
  v_status bed_status;
BEGIN
  PERFORM fn_assert_patient_active(p_patient_id);
  PERFORM fn_assert_doctor_active(p_doctor_id);
  SELECT b.status INTO v_status
  FROM beds b JOIN wards w ON w.id = b.ward_id
  WHERE b.id = p_bed_id AND b.deleted_at IS NULL AND w.deleted_at IS NULL
  FOR UPDATE OF b;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ліжко #% не знайдено', p_bed_id USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'available' THEN
    RAISE EXCEPTION 'Ліжко #% недоступне (статус %)', p_bed_id, v_status USING ERRCODE = 'P0409';
  END IF;
  IF EXISTS (SELECT 1 FROM admissions WHERE patient_id = p_patient_id AND status = 'active') THEN
    RAISE EXCEPTION 'Пацієнт уже перебуває у стаціонарі' USING ERRCODE = 'P0409';
  END IF;
  INSERT INTO admissions (patient_id, bed_id, doctor_id, reason)
  VALUES (p_patient_id, p_bed_id, p_doctor_id, p_reason)
  RETURNING id INTO p_id; -- ліжко займає тригер trg_admissions_bed_status
END $$;

CREATE PROCEDURE sp_transfer_patient(p_admission_id int, p_new_bed_id int)
LANGUAGE plpgsql AS $$
DECLARE
  v_adm    admissions;
  v_status bed_status;
BEGIN
  SELECT * INTO v_adm FROM admissions WHERE id = p_admission_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Госпіталізацію #% не знайдено', p_admission_id USING ERRCODE = 'P0002';
  END IF;
  IF v_adm.status <> 'active' THEN
    RAISE EXCEPTION 'Пацієнта вже виписано' USING ERRCODE = 'P0060';
  END IF;
  IF v_adm.bed_id = p_new_bed_id THEN
    RAISE EXCEPTION 'Пацієнт уже на цьому ліжку' USING ERRCODE = 'P0061';
  END IF;
  SELECT b.status INTO v_status
  FROM beds b JOIN wards w ON w.id = b.ward_id
  WHERE b.id = p_new_bed_id AND b.deleted_at IS NULL AND w.deleted_at IS NULL
  FOR UPDATE OF b;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ліжко #% не знайдено', p_new_bed_id USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'available' THEN
    RAISE EXCEPTION 'Ліжко #% недоступне (статус %)', p_new_bed_id, v_status USING ERRCODE = 'P0409';
  END IF;
  UPDATE admissions SET bed_id = p_new_bed_id WHERE id = p_admission_id; -- тригер звільняє / займає ліжка
END $$;

CREATE PROCEDURE sp_discharge_patient(p_admission_id int, p_summary text, INOUT p_invoice_id int DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE
  v_status admission_status;
BEGIN
  SELECT status INTO v_status FROM admissions WHERE id = p_admission_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Госпіталізацію #% не знайдено', p_admission_id USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'Пацієнта вже виписано' USING ERRCODE = 'P0060';
  END IF;
  UPDATE admissions
  SET status = 'discharged', discharged_at = now(), discharge_summary = p_summary
  WHERE id = p_admission_id; -- тригер звільняє ліжко
  CALL sp_invoice_generate_for_admission(p_admission_id, p_invoice_id);
END $$;

-- ---------- фінанси ----------
-- Номер з invoice_number_seq; відсоток покриття — з діючого полісу (fn_active_insurance)
CREATE PROCEDURE sp_invoice_create(p_patient_id int, p_appointment_id int, p_admission_id int,
                                   INOUT p_id int DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE
  v_coverage numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM patients WHERE id = p_patient_id) THEN
    RAISE EXCEPTION 'Пацієнта #% не знайдено', p_patient_id USING ERRCODE = 'P0002';
  END IF;
  IF p_appointment_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM appointments WHERE id = p_appointment_id AND patient_id = p_patient_id) THEN
      RAISE EXCEPTION 'Прийом #% не належить пацієнту #%', p_appointment_id, p_patient_id USING ERRCODE = 'P0070';
    END IF;
    IF EXISTS (SELECT 1 FROM invoices WHERE appointment_id = p_appointment_id AND status <> 'cancelled') THEN
      RAISE EXCEPTION 'Рахунок за цей прийом уже існує' USING ERRCODE = 'P0409';
    END IF;
  END IF;
  IF p_admission_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM admissions WHERE id = p_admission_id AND patient_id = p_patient_id) THEN
      RAISE EXCEPTION 'Госпіталізація #% не належить пацієнту #%', p_admission_id, p_patient_id USING ERRCODE = 'P0070';
    END IF;
    IF EXISTS (SELECT 1 FROM invoices WHERE admission_id = p_admission_id AND status <> 'cancelled') THEN
      RAISE EXCEPTION 'Рахунок за цю госпіталізацію вже існує' USING ERRCODE = 'P0409';
    END IF;
  END IF;

  SELECT coverage_percent INTO v_coverage FROM fn_active_insurance(p_patient_id);
  INSERT INTO invoices (number, patient_id, appointment_id, admission_id, insurance_coverage_percent)
  VALUES ('INV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('invoice_number_seq')::text, 6, '0'),
          p_patient_id, p_appointment_id, p_admission_id, coalesce(v_coverage, 0))
  RETURNING id INTO p_id;
END $$;

-- Суми рахунку перераховує тригер trg_invoice_items_recalc
CREATE PROCEDURE sp_invoice_add_item(p_invoice_id int, p_item_type invoice_item_type, p_description text,
                                     p_quantity numeric, p_unit_price numeric, INOUT p_id int DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE
  v_status invoice_status;
BEGIN
  SELECT status INTO v_status FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Рахунок #% не знайдено', p_invoice_id USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'Позиції можна додавати лише до чернетки рахунку (статус %)', v_status USING ERRCODE = 'P0071';
  END IF;
  INSERT INTO invoice_items (invoice_id, item_type, description, quantity, unit_price)
  VALUES (p_invoice_id, p_item_type, p_description, p_quantity, p_unit_price)
  RETURNING id INTO p_id;
END $$;

-- Рахунок за стаціонар: перебування + аналізи за період + консультації в межах госпіталізації; одразу виставляється
CREATE PROCEDURE sp_invoice_generate_for_admission(p_admission_id int, INOUT p_invoice_id int DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE
  v_adm  admissions;
  v_days int;
  v_ward text;
  v_rate numeric;
  v_item int;
  r      record;
BEGIN
  SELECT * INTO v_adm FROM admissions WHERE id = p_admission_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Госпіталізацію #% не знайдено', p_admission_id USING ERRCODE = 'P0002';
  END IF;
  CALL sp_invoice_create(v_adm.patient_id, NULL, p_admission_id, p_invoice_id);

  SELECT greatest(1, coalesce(v_adm.discharged_at, now())::date - v_adm.admitted_at::date), w.ward_number, w.daily_rate
  INTO v_days, v_ward, v_rate
  FROM beds b JOIN wards w ON w.id = b.ward_id WHERE b.id = v_adm.bed_id;
  CALL sp_invoice_add_item(p_invoice_id, 'stay', 'Перебування у стаціонарі, палата ' || v_ward, v_days, v_rate, v_item);

  FOR r IN
    SELECT t.name, t.price
    FROM lab_orders lo
    JOIN lab_order_items li ON li.lab_order_id = lo.id
    JOIN lab_test_types t ON t.id = li.test_type_id
    WHERE lo.patient_id = v_adm.patient_id AND lo.status <> 'cancelled'
      AND lo.ordered_at BETWEEN v_adm.admitted_at AND coalesce(v_adm.discharged_at, now())
    ORDER BY lo.id, t.id
  LOOP
    CALL sp_invoice_add_item(p_invoice_id, 'lab_test', 'Аналіз: ' || r.name, 1, r.price, v_item);
  END LOOP;

  FOR r IN
    SELECT u.full_name, d.consultation_fee
    FROM medical_records mr
    JOIN doctors d ON d.id = mr.doctor_id
    JOIN users u ON u.id = d.user_id
    WHERE mr.admission_id = p_admission_id
    ORDER BY mr.id
  LOOP
    CALL sp_invoice_add_item(p_invoice_id, 'consultation', 'Консультація: ' || r.full_name, 1, r.consultation_fee, v_item);
  END LOOP;

  CALL sp_invoice_issue(p_invoice_id, 14);
END $$;

-- draft → issued; рахунок з нульовою сумою до сплати (100% страховка) одразу стає paid
CREATE PROCEDURE sp_invoice_issue(p_invoice_id int, p_due_days int DEFAULT 14)
LANGUAGE plpgsql AS $$
DECLARE
  v_inv invoices;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Рахунок #% не знайдено', p_invoice_id USING ERRCODE = 'P0002';
  END IF;
  IF v_inv.status <> 'draft' THEN
    RAISE EXCEPTION 'Виставити можна лише чернетку рахунку (статус %)', v_inv.status USING ERRCODE = 'P0072';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM invoice_items WHERE invoice_id = p_invoice_id) THEN
    RAISE EXCEPTION 'Рахунок не містить позицій' USING ERRCODE = 'P0074';
  END IF;
  UPDATE invoices
  SET status = CASE WHEN total_due = 0 THEN 'paid'::invoice_status ELSE 'issued'::invoice_status END,
      issued_at = now(),
      due_date = current_date + coalesce(p_due_days, 14)
  WHERE id = p_invoice_id;
END $$;

-- BR-7: сума оплат не перевищує суму до сплати. Статус рахунку оновлює тригер trg_payments_invoice_status.
CREATE PROCEDURE sp_payment_register(p_invoice_id int, p_amount numeric, p_method payment_method, p_reference text,
                                     INOUT p_id int DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE
  v_inv invoices;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Рахунок #% не знайдено', p_invoice_id USING ERRCODE = 'P0002';
  END IF;
  IF v_inv.status NOT IN ('issued', 'partially_paid') THEN
    RAISE EXCEPTION 'Рахунок у статусі % не приймає оплат', v_inv.status USING ERRCODE = 'P0073';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Сума оплати має бути більшою за 0' USING ERRCODE = 'P0076';
  END IF;
  IF p_amount > v_inv.total_due - v_inv.paid_amount THEN
    RAISE EXCEPTION 'Сума оплати % перевищує залишок до сплати %', p_amount, v_inv.total_due - v_inv.paid_amount
      USING ERRCODE = 'P0075';
  END IF;
  INSERT INTO payments (invoice_id, amount, method, reference)
  VALUES (p_invoice_id, p_amount, p_method, p_reference)
  RETURNING id INTO p_id;
END $$;
