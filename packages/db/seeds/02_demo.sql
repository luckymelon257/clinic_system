-- 02: демо-стан, що «оживляє» UI: пацієнти з полісами, історія прийомів за ~14 місяців,
-- сьогоднішні / майбутні записи демо-лікаря, черга аналізів, активні госпіталізації,
-- неоплачені та прострочені рахунки, оплати по місяцях.
-- Історичні дати передаються явно (created_at / paid_at), тому тут прямі INSERT, а не процедури.

SELECT set_config('app.current_user_id', (SELECT id::text FROM users WHERE email = 'admin@clinic.local'), true);
SELECT setseed(0.17);

CREATE TEMP TABLE names ON COMMIT DROP AS
SELECT
  ARRAY['Петренко', 'Сидоренко', 'Коваленко', 'Бондаренко', 'Ткаченко', 'Кравченко', 'Олійник', 'Шевчук', 'Поліщук',
        'Бойко', 'Мельник', 'Коваль', 'Лисенко', 'Марченко', 'Руденко', 'Савченко', 'Мороз', 'Карпенко', 'Гончаренко',
        'Литвиненко', 'Павленко', 'Кузьменко', 'Левченко', 'Клименко', 'Харченко', 'Романюк', 'Ковальчук', 'Савчук',
        'Кравчук', 'Мартинюк', 'Гаврилюк', 'Остапчук', 'Дячук', 'Пономаренко', 'Тимошенко', 'Зінченко', 'Яковенко',
        'Нечипорук', 'Давиденко', 'Іваненко'] AS last,
  ARRAY['Олександр', 'Андрій', 'Сергій', 'Дмитро', 'Іван', 'Микола', 'Василь', 'Петро', 'Юрій', 'Володимир',
        'Максим', 'Богдан', 'Тарас', 'Олег', 'Роман', 'Віктор', 'Ігор', 'Артем', 'Денис', 'Михайло'] AS male,
  ARRAY['Олена', 'Наталія', 'Ірина', 'Оксана', 'Тетяна', 'Марія', 'Юлія', 'Світлана', 'Ганна', 'Людмила',
        'Катерина', 'Вікторія', 'Софія', 'Анастасія', 'Дарина', 'Валентина', 'Галина', 'Христина', 'Леся', 'Ольга'] AS female,
  ARRAY['Олександрович', 'Андрійович', 'Сергійович', 'Іванович', 'Миколайович', 'Васильович', 'Петрович',
        'Юрійович', 'Володимирович', 'Богданович'] AS male_mid,
  ARRAY['Олександрівна', 'Андріївна', 'Сергіївна', 'Іванівна', 'Миколаївна', 'Василівна', 'Петрівна',
        'Юріївна', 'Володимирівна', 'Богданівна'] AS female_mid,
  ARRAY['вул. Хрещатик', 'вул. Велика Васильківська', 'просп. Перемоги', 'вул. Саксаганського', 'вул. Антоновича',
        'бульв. Лесі Українки', 'вул. Січових Стрільців', 'просп. Бажана', 'вул. Драгоманова', 'вул. Ревуцького'] AS streets,
  ARRAY['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']::blood_type[] AS blood;

-- ---------- пацієнти ----------
INSERT INTO patients (user_id, last_name, first_name, middle_name, birth_date, sex, phone, email, address, blood_type,
                      emergency_contact_name, emergency_contact_phone, created_at)
VALUES ((SELECT id FROM users WHERE email = 'patient@clinic.local'), 'Іваненко', 'Петро', 'Олександрович',
        '1985-04-12', 'male', '+380671234567', 'patient@clinic.local', 'м. Київ, вул. Хрещатик, 10, кв. 5', 'A+',
        'Іваненко Марія Іванівна', '+380671234568', now() - interval '16 months');

INSERT INTO patients (last_name, first_name, middle_name, birth_date, sex, phone, email, address, blood_type,
                      emergency_contact_name, emergency_contact_phone, created_at)
SELECT n.last[i],
       CASE WHEN i % 2 = 1 THEN n.male[1 + (i * 7) % 20] ELSE n.female[1 + (i * 7) % 20] END,
       CASE WHEN i % 2 = 1 THEN n.male_mid[1 + (i * 3) % 10] ELSE n.female_mid[1 + (i * 3) % 10] END,
       CASE WHEN i % 8 = 0 THEN date '2012-01-01' + (i * 97) % 3000 ELSE date '1942-01-01' + (i * 523) % 22000 END,
       CASE WHEN i % 2 = 1 THEN 'male' ELSE 'female' END::sex_type,
       '+38067' || lpad((1000000 + i * 7919 % 8999999)::text, 7, '0'),
       CASE WHEN i % 3 <> 0 THEN 'patient' || i || '@mail.example' END,
       'м. Київ, ' || n.streets[1 + i % 10] || ', ' || (i * 3 % 120 + 1),
       CASE WHEN i % 5 <> 0 THEN n.blood[1 + i % 8] END,
       CASE WHEN i % 4 <> 0 THEN n.last[1 + (i + 11) % 39] || ' ' || n.female[1 + (i * 3) % 20] END,
       CASE WHEN i % 4 <> 0 THEN '+38050' || lpad((2000000 + i * 4231 % 7999999)::text, 7, '0') END,
       now() - interval '16 months' + i * interval '2 days'
FROM generate_series(1, 39) i, names n;

CREATE TEMP TABLE demo_patients ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY id)::int AS rn, id FROM patients;

-- Поліси: демо-пацієнт 80%; кожен третій — діючий поліс; кожен дев'ятий — прострочений
INSERT INTO patient_insurances (patient_id, company_id, policy_number, coverage_percent, valid_from, valid_to, created_at)
SELECT p.id, c.id, 'MS-0000001', 80, current_date - 730, current_date + 365, now() - interval '16 months'
FROM patients p, insurance_companies c
WHERE p.email = 'patient@clinic.local' AND c.name = 'Медичний Щит';

INSERT INTO patient_insurances (patient_id, company_id, policy_number, coverage_percent, valid_from, valid_to, created_at)
SELECT dp.id, c.id, 'POL-' || lpad(dp.rn::text, 6, '0'),
       (ARRAY[30, 50, 70, 100])[1 + dp.rn % 4],
       CASE WHEN dp.rn % 9 = 0 THEN current_date - 900 ELSE current_date - 500 END,
       CASE WHEN dp.rn % 9 = 0 THEN current_date - 400 ELSE current_date + 200 END,
       now() - interval '15 months'
FROM demo_patients dp
JOIN insurance_companies c ON c.id = (SELECT min(id) FROM insurance_companies) + dp.rn % 5
WHERE dp.rn > 1 AND dp.rn % 3 = 0;

-- ---------- прийоми ----------
CREATE TEMP TABLE reasons ON COMMIT DROP AS
SELECT ARRAY['Плановий огляд', 'Підвищений тиск', 'Головний біль', 'Кашель, температура', 'Біль у животі',
             'Контроль аналізів', 'Біль у спині', 'Повторний прийом', 'Слабкість, втома', 'Консультація щодо лікування',
             'Профілактичний огляд', 'Алергічна реакція'] AS arr;

-- Історія: ~40% робочих днів кожного лікаря — один прийом у випадковому слоті (перетинів немає)
INSERT INTO appointments (patient_id, doctor_id, starts_at, ends_at, status, reason, cancel_reason, created_at)
SELECT dp.id, x.doctor_id, x.st, x.st + make_interval(mins => x.slot_minutes),
       CASE WHEN x.r < 0.85 THEN 'completed' WHEN x.r < 0.93 THEN 'cancelled' ELSE 'no_show' END::appointment_status,
       rs.arr[1 + (x.k % 12)],
       CASE WHEN x.r >= 0.85 AND x.r < 0.93 THEN 'Пацієнт скасував запис' END,
       x.st - interval '5 days'
FROM (
  SELECT s.doctor_id, s.slot_minutes, random() AS r, (random() * 1000)::int AS k,
         1 + floor(random() * 40)::int AS prn,
         (day::date + s.start_time
           + make_interval(mins => s.slot_minutes
                * floor(random() * (extract(epoch FROM s.end_time - s.start_time) / 60 / s.slot_minutes))::int))::timestamptz AS st
  FROM generate_series(current_date - 425, current_date - 1, interval '1 day') day
  JOIN doctor_schedules s ON s.weekday = extract(isodow FROM day)
  WHERE random() < 0.4
) x
JOIN demo_patients dp ON dp.rn = x.prn
CROSS JOIN reasons rs
ORDER BY x.st;

-- Сьогодні: демо-лікар — 9 записів (минулі завершені, поточний триває, решта заплановані / підтверджені)
INSERT INTO appointments (patient_id, doctor_id, starts_at, ends_at, status, reason, created_at)
SELECT dp.id, d.id, st, st + interval '30 minutes',
       CASE WHEN st + interval '30 minutes' <= now() THEN 'completed'
            WHEN st <= now() THEN 'in_progress'
            WHEN n % 2 = 0 THEN 'confirmed'
            ELSE 'scheduled' END::appointment_status,
       rs.arr[1 + n::int], now() - interval '3 days'
FROM unnest(ARRAY['08:30', '09:00', '10:00', '11:30', '13:00', '14:00', '15:30', '17:00', '18:30']::time[])
       WITH ORDINALITY AS t (tm, n)
CROSS JOIN LATERAL (SELECT (current_date + t.tm)::timestamptz AS st) s
JOIN doctors d ON d.user_id = (SELECT id FROM users WHERE email = 'doctor@clinic.local')
JOIN demo_patients dp ON dp.rn = n::int
CROSS JOIN reasons rs;

-- Сьогодні (інші лікарі, якщо працюють) і наступні 7 днів: кілька записів у фіксованих слотах
INSERT INTO appointments (patient_id, doctor_id, starts_at, ends_at, status, reason, created_at)
SELECT dp.id, s.doctor_id, st, st + make_interval(mins => s.slot_minutes),
       CASE WHEN st + make_interval(mins => s.slot_minutes) <= now() THEN 'completed'
            WHEN st <= now() THEN 'in_progress'
            WHEN k % 3 = 0 THEN 'confirmed'
            ELSE 'scheduled' END::appointment_status,
       rs.arr[1 + (k % 12)], now() - interval '1 day'
FROM generate_series(current_date, current_date + 7, interval '1 day') day
JOIN doctor_schedules s ON s.weekday = extract(isodow FROM day)
CROSS JOIN unnest(ARRAY[1, 3, 6, 9]) k
CROSS JOIN LATERAL (SELECT (day::date + s.start_time + make_interval(mins => s.slot_minutes * k))::timestamptz AS st) t
JOIN demo_patients dp ON dp.rn = 1 + (s.doctor_id * 7 + k * 3 + extract(doy FROM day)::int) % 40
CROSS JOIN reasons rs
WHERE NOT (day::date = current_date AND s.doctor_id = (SELECT d.id FROM doctors d JOIN users u ON u.id = d.user_id
                                                       WHERE u.email = 'doctor@clinic.local'))
  AND NOT (day::date = current_date + 1 AND k = 9);

-- ---------- медичні записи, діагнози, рецепти ----------
INSERT INTO medical_records (appointment_id, patient_id, doctor_id, complaints, examination, conclusion,
                             recommendations, created_at)
SELECT a.id, a.patient_id, a.doctor_id,
       coalesce(a.reason, 'Скарг немає'),
       (ARRAY['Загальний стан задовільний. АТ 130/85, ЧСС 76.', 'Стан середньої тяжкості. Т 37,8 °C.',
              'Шкіра звичайного кольору, дихання везикулярне.', 'Живіт мʼякий, помірно болючий в епігастрії.'])[1 + a.id % 4],
       (ARRAY['Стан стабільний, призначено лікування.', 'Потребує дообстеження.', 'Позитивна динаміка.',
              'Рекомендовано контроль через 2 тижні.'])[1 + a.id % 4],
       (ARRAY['Режим дня, дієта, контроль тиску.', 'Повторний огляд через 14 днів.', 'Пити більше рідини, спокій.',
              'Виконати призначені аналізи.'])[1 + a.id % 4],
       a.ends_at
FROM appointments a
WHERE a.status = 'completed'
ORDER BY a.ends_at;

INSERT INTO diagnoses (medical_record_id, icd10_code, kind, notes, created_at)
SELECT mr.id, c.arr[1 + (mr.id * 13) % cardinality(c.arr)], 'primary', NULL, mr.created_at
FROM medical_records mr, (SELECT array_agg(code ORDER BY code) AS arr FROM icd10_codes) c;

INSERT INTO diagnoses (medical_record_id, icd10_code, kind, notes, created_at)
SELECT mr.id, c.arr[1 + (mr.id * 13 + 17) % cardinality(c.arr)], 'secondary', 'Супутній стан', mr.created_at
FROM medical_records mr, (SELECT array_agg(code ORDER BY code) AS arr FROM icd10_codes) c
WHERE mr.id % 3 = 0;

INSERT INTO prescriptions (medical_record_id, issued_at, valid_until, created_at)
SELECT mr.id, mr.created_at, mr.created_at::date + 30, mr.created_at
FROM medical_records mr
WHERE mr.id % 5 IN (0, 2)
ORDER BY mr.id;

INSERT INTO prescription_items (prescription_id, medication_id, dosage, frequency, duration_days, quantity, instructions)
SELECT p.id, m.arr[1 + (p.id * 7 + j * 11) % cardinality(m.arr)],
       (ARRAY['1 таблетка', '2 таблетки', '5 мл', '1 інгаляція'])[1 + (p.id + j) % 4],
       (ARRAY['1 раз на день', '2 рази на день', '3 рази на день'])[1 + (p.id + j) % 3],
       (ARRAY[5, 7, 10, 14, 30])[1 + (p.id + j) % 5],
       (ARRAY[10, 14, 20, 28, 30])[1 + (p.id + j) % 5],
       CASE WHEN j = 0 THEN 'Після їжі' END
FROM prescriptions p
CROSS JOIN (SELECT array_agg(id ORDER BY id) AS arr FROM medications) m
CROSS JOIN generate_series(0, 1) j
WHERE j = 0 OR p.id % 2 = 0;

-- ---------- лабораторія ----------
-- Завершені історичні направлення (25% записів), 3 тести з результатами (частина поза нормою)
INSERT INTO lab_orders (patient_id, doctor_id, medical_record_id, priority, status, ordered_at, completed_at, created_at)
SELECT mr.patient_id, mr.doctor_id, mr.id, CASE WHEN mr.id % 7 = 0 THEN 'urgent' ELSE 'routine' END::lab_priority,
       'completed', mr.created_at, mr.created_at + interval '1 day', mr.created_at
FROM medical_records mr
WHERE mr.id % 4 = 1 AND mr.created_at < current_date
ORDER BY mr.created_at;

-- Черга: 8 нових направлень (частина термінові) + 2 у роботі
INSERT INTO lab_orders (patient_id, doctor_id, priority, status, ordered_at, created_at)
SELECT dp.id, d.id, CASE WHEN n % 3 = 0 THEN 'urgent' ELSE 'routine' END::lab_priority,
       CASE WHEN n > 8 THEN 'in_progress' ELSE 'ordered' END::lab_order_status,
       now() - make_interval(hours => n * 3), now() - make_interval(hours => n * 3)
FROM generate_series(1, 10) n
JOIN demo_patients dp ON dp.rn = n + 2
JOIN doctors d ON d.id = (SELECT min(id) FROM doctors) + n % 4;

INSERT INTO lab_order_items (lab_order_id, test_type_id)
SELECT lo.id, t.arr[1 + (lo.id * 5 + j) % cardinality(t.arr)]
FROM lab_orders lo
CROSS JOIN (SELECT array_agg(id ORDER BY id) AS arr FROM lab_test_types) t
CROSS JOIN generate_series(0, 2) j;

INSERT INTO lab_results (lab_order_id, test_type_id, value_numeric, value_text, recorded_at, created_at)
SELECT li.lab_order_id, li.test_type_id, v.num,
       CASE WHEN v.num IS NULL THEN 'Без патологічних змін' END,
       lo.ordered_at + interval '20 hours', lo.ordered_at + interval '20 hours'
FROM lab_order_items li
JOIN lab_orders lo ON lo.id = li.lab_order_id
JOIN lab_test_types t ON t.id = li.test_type_id
CROSS JOIN LATERAL (
  SELECT round((CASE
           WHEN t.ref_min IS NOT NULL AND t.ref_max IS NOT NULL
             THEN t.ref_min + (t.ref_max - t.ref_min) * (random() * 1.5 - 0.25)
           WHEN t.ref_max IS NOT NULL THEN t.ref_max * random() * 1.3
           WHEN t.ref_min IS NOT NULL THEN t.ref_min * (0.7 + random())
         END)::numeric, 2) AS num
) v
WHERE lo.status = 'completed'
   OR (lo.status = 'in_progress' AND li.test_type_id = (SELECT min(test_type_id) FROM lab_order_items WHERE lab_order_id = lo.id))
ORDER BY lo.ordered_at;

-- ---------- стаціонар ----------
-- Історичні госпіталізації (виписані): одна на ліжко, у минулому
INSERT INTO admissions (patient_id, bed_id, doctor_id, admitted_at, discharged_at, reason, discharge_summary, status,
                        created_at)
SELECT dp.id, b.id, dep.head_doctor_id, adm, adm + make_interval(days => 2 + b.rn % 7),
       (ARRAY['Загострення хронічного захворювання', 'Планове оперативне втручання', 'Гіпертонічний криз',
              'Пневмонія', 'Спостереження після травми'])[1 + b.rn % 5],
       'Виписаний у задовільному стані, рекомендації надано.', 'discharged', adm
FROM (SELECT b.*, row_number() OVER (ORDER BY b.id)::int AS rn FROM beds b) b
JOIN wards w ON w.id = b.ward_id
JOIN departments dep ON dep.id = w.department_id
JOIN demo_patients dp ON dp.rn = 1 + (b.rn * 3) % 40
CROSS JOIN LATERAL (SELECT now() - make_interval(days => b.rn * 9 + 20) AS adm) t
WHERE b.rn <= 30;

-- Активні госпіталізації: 10 вільних ліжок у різних палатах (тригер займає ліжка)
INSERT INTO admissions (patient_id, bed_id, doctor_id, admitted_at, reason, created_at)
SELECT dp.id, b.id, dep.head_doctor_id, now() - make_interval(days => b.rn, hours => b.rn * 2),
       (ARRAY['Гострий бронхіт, тяжкий перебіг', 'Нестабільна стенокардія', 'Інсульт, спостереження',
              'Гострий апендицит', 'Пневмонія у дитини', 'Стан після операції'])[1 + b.rn % 6],
       now() - make_interval(days => b.rn, hours => b.rn * 2)
FROM (
  SELECT DISTINCT ON (b.ward_id) b.*, dense_rank() OVER (ORDER BY b.ward_id)::int AS rn
  FROM beds b WHERE b.status = 'available' ORDER BY b.ward_id, b.id
) b
JOIN wards w ON w.id = b.ward_id
JOIN departments dep ON dep.id = w.department_id
JOIN demo_patients dp ON dp.rn = 10 + b.rn
WHERE b.rn <= 10;

INSERT INTO medical_records (admission_id, patient_id, doctor_id, complaints, examination, conclusion, recommendations,
                             created_at)
SELECT a.id, a.patient_id, a.doctor_id, a.reason, 'Огляд при надходженні: стан середньої тяжкості.',
       'Госпіталізовано для лікування та спостереження.', 'Постільний режим, моніторинг показників.',
       a.admitted_at + interval '1 hour'
FROM admissions a;

INSERT INTO diagnoses (medical_record_id, icd10_code, kind, created_at)
SELECT mr.id, (ARRAY['J20.9', 'I20.9', 'I63.9', 'K35.8', 'J18.9', 'I10'])[1 + mr.id % 6], 'primary', mr.created_at
FROM medical_records mr
WHERE mr.admission_id IS NOT NULL;

-- ---------- рахунки та оплати ----------
-- Консультації за завершені прийоми + стаціонар за виписані госпіталізації
INSERT INTO invoices (number, patient_id, appointment_id, status, insurance_coverage_percent, issued_at, due_date,
                      created_at)
SELECT 'INV-' || to_char(a.ends_at, 'YYYY') || '-' || lpad(nextval('invoice_number_seq')::text, 6, '0'),
       a.patient_id, a.id, 'issued', coalesce((fn_active_insurance(a.patient_id, a.starts_at::date)).coverage_percent, 0),
       a.ends_at, a.ends_at::date + 14, a.ends_at
FROM appointments a
WHERE a.status = 'completed'
ORDER BY a.ends_at;

INSERT INTO invoices (number, patient_id, admission_id, status, insurance_coverage_percent, issued_at, due_date,
                      created_at)
SELECT 'INV-' || to_char(a.discharged_at, 'YYYY') || '-' || lpad(nextval('invoice_number_seq')::text, 6, '0'),
       a.patient_id, a.id, 'issued',
       coalesce((fn_active_insurance(a.patient_id, a.admitted_at::date)).coverage_percent, 0),
       a.discharged_at, a.discharged_at::date + 14, a.discharged_at
FROM admissions a
WHERE a.status = 'discharged'
ORDER BY a.discharged_at;

INSERT INTO invoice_items (invoice_id, item_type, description, quantity, unit_price, created_at)
SELECT i.id, 'consultation', 'Консультація: ' || u.full_name, 1, d.consultation_fee, i.created_at
FROM invoices i
JOIN appointments a ON a.id = i.appointment_id
JOIN doctors d ON d.id = a.doctor_id
JOIN users u ON u.id = d.user_id;

INSERT INTO invoice_items (invoice_id, item_type, description, quantity, unit_price, created_at)
SELECT i.id, 'stay', 'Перебування у стаціонарі, палата ' || w.ward_number,
       greatest(1, a.discharged_at::date - a.admitted_at::date), w.daily_rate, i.created_at
FROM invoices i
JOIN admissions a ON a.id = i.admission_id
JOIN beds b ON b.id = a.bed_id
JOIN wards w ON w.id = b.ward_id;

INSERT INTO invoice_items (invoice_id, item_type, description, quantity, unit_price, created_at)
SELECT i.id, 'lab_test', 'Аналіз: ' || t.name, 1, t.price, i.created_at
FROM invoices i
JOIN medical_records mr ON mr.appointment_id = i.appointment_id
JOIN lab_orders lo ON lo.medical_record_id = mr.id
JOIN lab_order_items li ON li.lab_order_id = lo.id
JOIN lab_test_types t ON t.id = li.test_type_id;

UPDATE invoices SET status = 'paid' WHERE status = 'issued' AND total_due = 0;

-- Старші за місяць — переважно оплачені; свіжі — частина часткових / неоплачених (а отже й прострочених)
INSERT INTO payments (invoice_id, amount, method, reference, paid_at, created_at)
SELECT x.id, x.amount, x.method, x.reference, x.paid_at, x.paid_at
FROM (
  SELECT i.id,
         CASE WHEN r.v < CASE WHEN i.created_at < now() - interval '30 days' THEN 0.92 ELSE 0.5 END
              THEN i.total_due ELSE round(i.total_due / 2, 2) END AS amount,
         (ARRAY['cash', 'card', 'card', 'bank_transfer', 'insurance'])[1 + i.id % 5]::payment_method AS method,
         CASE WHEN i.id % 5 IN (1, 2) THEN 'TXN-' || lpad(i.id::text, 8, '0') END AS reference,
         least(i.created_at + make_interval(hours => (i.id * 7) % 72), now() - interval '1 minute') AS paid_at,
         r.v,
         CASE WHEN i.created_at < now() - interval '30 days' THEN 0.96 ELSE 0.7 END AS threshold
  FROM invoices i
  CROSS JOIN LATERAL (SELECT random() + i.id * 0 AS v) r
  WHERE i.status = 'issued' AND i.total_due > 0
) x
WHERE x.v < x.threshold
ORDER BY x.paid_at;

-- Трохи історії змін для аудиту: оновлення пацієнта, soft delete пацієнта і препарату
UPDATE patients SET address = 'м. Київ, вул. Хрещатик, 12, кв. 7' WHERE email = 'patient@clinic.local';
DELETE FROM patients WHERE id = (SELECT id FROM demo_patients WHERE rn = 40);
DELETE FROM medications WHERE name = 'Діазепам';

REFRESH MATERIALIZED VIEW mv_monthly_revenue;
