-- 005: користувацькі функції (docs/02-sql-objects.md §2)
-- fn_search_patients повертає SETOF v_patients, тому створюється у 008 після view.

-- Вік у роках. p_on має DEFAULT current_date (обчислюється у місці виклику), тож сама функція IMMUTABLE.
CREATE FUNCTION fn_patient_age(p_dob date, p_on date DEFAULT current_date) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT date_part('year', age(p_on, p_dob))::int
$$;

CREATE FUNCTION fn_full_name(p_last text, p_first text, p_middle text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_last || ' ' || p_first || coalesce(' ' || nullif(btrim(p_middle), ''), '')
$$;

-- Лікар доступний: інтервал у межах розкладу на цей день, вирівняний по сітці слотів, і без перетинів
CREATE FUNCTION fn_is_doctor_available(
  p_doctor_id int, p_start timestamptz, p_end timestamptz, p_exclude_appointment_id int DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
           SELECT 1
           FROM doctor_schedules s
           JOIN doctors d ON d.id = s.doctor_id AND d.deleted_at IS NULL
           WHERE s.doctor_id = p_doctor_id
             AND s.weekday = extract(isodow FROM p_start)
             AND p_start::date = p_end::date
             AND p_start::time >= s.start_time
             AND p_end::time <= s.end_time
             AND (extract(epoch FROM p_start::time - s.start_time)::int / 60) % s.slot_minutes = 0
         )
     AND NOT EXISTS (
           SELECT 1
           FROM appointments a
           WHERE a.doctor_id = p_doctor_id
             AND a.status NOT IN ('cancelled', 'no_show')
             AND tstzrange(a.starts_at, a.ends_at) && tstzrange(p_start, p_end)
             AND a.id IS DISTINCT FROM p_exclude_appointment_id
         )
$$;

-- Вільні слоти лікаря на дату: сітка розкладу мінус зайняті прийоми; минулі слоти не повертаються
CREATE FUNCTION fn_doctor_free_slots(p_doctor_id int, p_date date)
RETURNS TABLE (slot_start timestamptz, slot_end timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT g.slot_start, g.slot_start + make_interval(mins => s.slot_minutes)
  FROM doctor_schedules s
  JOIN doctors d ON d.id = s.doctor_id AND d.deleted_at IS NULL
  CROSS JOIN LATERAL (
    SELECT gs::timestamptz AS slot_start
    FROM generate_series(p_date + s.start_time,
                         p_date + s.end_time - make_interval(mins => s.slot_minutes),
                         make_interval(mins => s.slot_minutes)) gs
  ) g
  WHERE s.doctor_id = p_doctor_id
    AND s.weekday = extract(isodow FROM p_date)
    AND g.slot_start > now()
    AND NOT EXISTS (
      SELECT 1 FROM appointments a
      WHERE a.doctor_id = p_doctor_id
        AND a.status NOT IN ('cancelled', 'no_show')
        AND tstzrange(a.starts_at, a.ends_at) && tstzrange(g.slot_start, g.slot_start + make_interval(mins => s.slot_minutes))
    )
  ORDER BY 1
$$;

-- Діючий на дату поліс з максимальним покриттям (NULL-рядок, якщо полісу немає)
CREATE FUNCTION fn_active_insurance(p_patient_id int, p_on date DEFAULT current_date) RETURNS patient_insurances
LANGUAGE sql STABLE AS $$
  SELECT pi.*
  FROM patient_insurances pi
  JOIN insurance_companies c ON c.id = pi.company_id AND c.deleted_at IS NULL
  WHERE pi.patient_id = p_patient_id
    AND pi.valid_from <= p_on
    AND (pi.valid_to IS NULL OR pi.valid_to >= p_on)
  ORDER BY pi.coverage_percent DESC, pi.id DESC
  LIMIT 1
$$;

-- Вартість перебування: кількість діб (мін. 1) × вартість доби палати поточного ліжка
-- ponytail: при переведенні між палатами рахується тариф останньої палати; окремі сегменти — якщо знадобиться точність
CREATE FUNCTION fn_calc_stay_cost(p_admission_id int) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT round(greatest(1, coalesce(a.discharged_at, now())::date - a.admitted_at::date) * w.daily_rate, 2)
  FROM admissions a
  JOIN beds b ON b.id = a.bed_id
  JOIN wards w ON w.id = b.ward_id
  WHERE a.id = p_admission_id
$$;

-- % зайнятих ліжок відділення (ліжка на обслуговуванні входять у загальну кількість)
CREATE FUNCTION fn_department_occupancy(p_department_id int) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce(round(100.0 * count(*) FILTER (WHERE b.status = 'occupied') / nullif(count(*), 0), 2), 0)
  FROM beds b
  JOIN wards w ON w.id = b.ward_id
  WHERE w.department_id = p_department_id
    AND b.deleted_at IS NULL
    AND w.deleted_at IS NULL
$$;

-- Хронологія пацієнта: прийоми, діагнози, рецепти, аналізи, госпіталізації / виписки (новіші спочатку)
CREATE FUNCTION fn_patient_history(p_patient_id int)
RETURNS TABLE (event_at timestamptz, event_type text, description text, doctor text, ref_id int)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM patients WHERE id = p_patient_id) THEN
    RAISE EXCEPTION 'Пацієнта #% не знайдено', p_patient_id USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  WITH doc AS (
    SELECT d.id, u.full_name, s.name AS specialization
    FROM doctors d JOIN users u ON u.id = d.user_id JOIN specializations s ON s.id = d.specialization_id
  )
  SELECT h.event_at, h.event_type, h.description, h.doctor, h.ref_id
  FROM (
    SELECT a.starts_at AS event_at, 'appointment'::text AS event_type,
           'Прийом (' || doc.specialization || '), статус: ' || a.status::text
             || coalesce('. Причина: ' || a.reason, '') AS description,
           doc.full_name AS doctor, a.id AS ref_id
    FROM appointments a JOIN doc ON doc.id = a.doctor_id
    WHERE a.patient_id = p_patient_id

    UNION ALL
    SELECT mr.created_at, 'diagnosis',
           'Діагноз (' || CASE dg.kind WHEN 'primary' THEN 'основний' ELSE 'супутній' END || '): '
             || dg.icd10_code || ' ' || ic.title || coalesce('. ' || dg.notes, ''),
           doc.full_name, mr.id
    FROM diagnoses dg
    JOIN medical_records mr ON mr.id = dg.medical_record_id
    JOIN icd10_codes ic ON ic.code = dg.icd10_code
    JOIN doc ON doc.id = mr.doctor_id
    WHERE mr.patient_id = p_patient_id

    UNION ALL
    SELECT p.issued_at, 'prescription',
           'Рецепт: ' || string_agg(m.name || coalesce(' ' || m.strength, '') || ' — ' || pi.dosage || ', ' || pi.frequency,
                                    '; ' ORDER BY pi.id),
           doc.full_name, mr.id
    FROM prescriptions p
    JOIN medical_records mr ON mr.id = p.medical_record_id
    JOIN prescription_items pi ON pi.prescription_id = p.id
    JOIN medications m ON m.id = pi.medication_id
    JOIN doc ON doc.id = mr.doctor_id
    WHERE mr.patient_id = p_patient_id
    GROUP BY p.id, p.issued_at, doc.full_name, mr.id

    UNION ALL
    SELECT lo.ordered_at, 'lab_order',
           'Направлення на аналізи (' || CASE lo.priority WHEN 'urgent' THEN 'терміново' ELSE 'планово' END || '): '
             || string_agg(t.name, ', ' ORDER BY t.name),
           doc.full_name, lo.id
    FROM lab_orders lo
    JOIN lab_order_items li ON li.lab_order_id = lo.id
    JOIN lab_test_types t ON t.id = li.test_type_id
    JOIN doc ON doc.id = lo.doctor_id
    WHERE lo.patient_id = p_patient_id
    GROUP BY lo.id, lo.ordered_at, lo.priority, doc.full_name

    UNION ALL
    SELECT r.recorded_at, 'lab_result',
           t.name || ': ' || coalesce(r.value_numeric::text || coalesce(' ' || t.unit, ''), r.value_text)
             || CASE WHEN r.is_abnormal THEN ' (поза нормою)' ELSE '' END,
           doc.full_name, lo.id
    FROM lab_results r
    JOIN lab_orders lo ON lo.id = r.lab_order_id
    JOIN lab_test_types t ON t.id = r.test_type_id
    JOIN doc ON doc.id = lo.doctor_id
    WHERE lo.patient_id = p_patient_id

    UNION ALL
    SELECT ad.admitted_at, 'admission',
           'Госпіталізація: ' || dep.name || ', палата ' || w.ward_number || ', ліжко ' || b.bed_number
             || coalesce('. Причина: ' || ad.reason, ''),
           doc.full_name, ad.id
    FROM admissions ad
    JOIN beds b ON b.id = ad.bed_id
    JOIN wards w ON w.id = b.ward_id
    JOIN departments dep ON dep.id = w.department_id
    JOIN doc ON doc.id = ad.doctor_id
    WHERE ad.patient_id = p_patient_id

    UNION ALL
    SELECT ad.discharged_at, 'discharge',
           'Виписка' || coalesce(': ' || ad.discharge_summary, ''),
           doc.full_name, ad.id
    FROM admissions ad
    JOIN doc ON doc.id = ad.doctor_id
    WHERE ad.patient_id = p_patient_id AND ad.discharged_at IS NOT NULL
  ) h
  ORDER BY h.event_at DESC, h.event_type;
END $$;

-- Дані для входу (F-01): єдине джерело password_hash; лише не видалені користувачі
CREATE FUNCTION fn_auth_user(p_email text)
RETURNS TABLE (id int, email text, role user_role, full_name text, password_hash text, is_active boolean,
               doctor_id int, patient_id int)
LANGUAGE sql STABLE AS $$
  SELECT u.id, u.email, r.code, u.full_name, u.password_hash, u.is_active, d.id, p.id
  FROM users u
  JOIN roles r ON r.id = u.role_id
  LEFT JOIN doctors d ON d.user_id = u.id AND d.deleted_at IS NULL
  LEFT JOIN patients p ON p.user_id = u.id AND p.deleted_at IS NULL
  WHERE lower(u.email) = lower(btrim(p_email))
    AND u.deleted_at IS NULL
$$;
