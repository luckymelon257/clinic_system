-- 03: обсяг для EXPLAIN / звітів (лише reset з volume = true):
-- ~10k пацієнтів, ~100k прийомів за 2 роки (сітка слотів → без перетинів, ON CONFLICT DO NOTHING
-- пропускає слоти, зайняті демо-даними), рахунки й оплати у хронологічному порядку (BRIN), рядки audit_log.

SELECT set_config('app.current_user_id', (SELECT id::text FROM users WHERE email = 'admin@clinic.local'), true);
SELECT setseed(0.42);

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
  ARRAY['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']::blood_type[] AS blood;

-- ---------- 10 000 пацієнтів ----------
INSERT INTO patients (last_name, first_name, middle_name, birth_date, sex, phone, email, address, blood_type, created_at)
SELECT n.last[1 + floor(x.r1 * 40)::int],
       CASE WHEN x.male THEN n.male[1 + floor(x.r2 * 20)::int] ELSE n.female[1 + floor(x.r2 * 20)::int] END,
       CASE WHEN x.male THEN n.male_mid[1 + floor(x.r3 * 10)::int] ELSE n.female_mid[1 + floor(x.r3 * 10)::int] END,
       date '1935-01-01' + floor(x.r4 * 32000)::int,
       CASE WHEN x.male THEN 'male' ELSE 'female' END::sex_type,
       '+38063' || lpad(x.i::text, 7, '0'),
       CASE WHEN x.r5 < 0.6 THEN 'p' || x.i || '@mail.example' END,
       'м. Київ, буд. ' || (1 + x.i % 200),
       CASE WHEN x.r5 < 0.8 THEN n.blood[1 + x.i % 8] END,
       now() - interval '2 years' + (x.i / 10000.0) * interval '2 years'
FROM (
  SELECT i, random() < 0.5 AS male, random() AS r1, random() AS r2, random() AS r3, random() AS r4, random() AS r5
  FROM generate_series(1, 10000) i
) x, names n
ORDER BY x.i;

CREATE TEMP TABLE vp ON COMMIT DROP AS
SELECT min(id) AS lo, max(id) AS hi FROM patients WHERE phone::text LIKE '+38063%';

-- Поліси у ~30% пацієнтів
INSERT INTO patient_insurances (patient_id, company_id, policy_number, coverage_percent, valid_from, valid_to, created_at)
SELECT p.id, c.lo + p.id % 5, 'VP-' || lpad(p.id::text, 7, '0'), (ARRAY[20, 30, 50, 70, 80, 100])[1 + p.id % 6],
       p.created_at::date, p.created_at::date + 900, p.created_at
FROM patients p, vp, (SELECT min(id) AS lo FROM insurance_companies) c
WHERE p.id BETWEEN vp.lo AND vp.hi AND p.id % 10 < 3;

-- ---------- ~100 000 прийомів за 2 роки ----------
INSERT INTO appointments (patient_id, doctor_id, starts_at, ends_at, status, reason, cancel_reason, created_at)
SELECT x.patient_id, x.doctor_id, x.st, x.st + make_interval(mins => x.slot_minutes),
       CASE WHEN x.r < 0.82 THEN 'completed' WHEN x.r < 0.91 THEN 'cancelled' ELSE 'no_show' END::appointment_status,
       'Прийом',
       CASE WHEN x.r >= 0.82 AND x.r < 0.91 THEN 'Скасовано пацієнтом' END,
       x.st - interval '7 days'
FROM (
  SELECT s.doctor_id, s.slot_minutes, random() AS r,
         vp.lo + floor(random() * (vp.hi - vp.lo + 1))::int AS patient_id,
         (day::date + s.start_time + make_interval(mins => s.slot_minutes * k))::timestamptz AS st
  FROM generate_series(current_date - 730, current_date - 1, interval '1 day') day
  JOIN doctor_schedules s ON s.weekday = extract(isodow FROM day)
  CROSS JOIN LATERAL generate_series(0, (extract(epoch FROM s.end_time - s.start_time) / 60 / s.slot_minutes)::int - 1) k
  CROSS JOIN vp
  WHERE random() < 0.8
) x
ORDER BY x.st
ON CONFLICT DO NOTHING;

-- ---------- рахунки (~35% завершених) та оплати ----------
INSERT INTO invoices (number, patient_id, appointment_id, status, insurance_coverage_percent, issued_at, due_date,
                      created_at)
SELECT 'INV-' || to_char(a.ends_at, 'YYYY') || '-' || lpad(nextval('invoice_number_seq')::text, 6, '0'),
       a.patient_id, a.id, 'issued',
       coalesce((SELECT pi.coverage_percent FROM patient_insurances pi
                 WHERE pi.patient_id = a.patient_id AND a.starts_at::date BETWEEN pi.valid_from AND pi.valid_to), 0),
       a.ends_at, a.ends_at::date + 14, a.ends_at
FROM appointments a, vp
WHERE a.status = 'completed' AND a.patient_id BETWEEN vp.lo AND vp.hi AND random() < 0.35
ORDER BY a.ends_at;

INSERT INTO invoice_items (invoice_id, item_type, description, quantity, unit_price, created_at)
SELECT i.id, 'consultation', 'Консультація', 1, d.consultation_fee, i.created_at
FROM invoices i
JOIN appointments a ON a.id = i.appointment_id
JOIN doctors d ON d.id = a.doctor_id
CROSS JOIN vp
WHERE i.patient_id BETWEEN vp.lo AND vp.hi
ORDER BY i.id;

UPDATE invoices SET status = 'paid' WHERE status = 'issued' AND total_due = 0;

INSERT INTO payments (invoice_id, amount, method, reference, paid_at, created_at)
SELECT x.id, CASE WHEN x.r < 0.9 THEN x.total_due ELSE round(x.total_due / 2, 2) END, x.method, NULL, x.paid_at, x.paid_at
FROM (
  SELECT i.id, i.total_due, random() AS r,
         (ARRAY['cash', 'card', 'card', 'bank_transfer', 'insurance'])[1 + i.id % 5]::payment_method AS method,
         least(i.created_at + make_interval(hours => (i.id * 7) % 96), now() - interval '1 minute') AS paid_at
  FROM invoices i, vp
  WHERE i.status = 'issued' AND i.total_due > 0 AND i.patient_id BETWEEN vp.lo AND vp.hi
) x
WHERE x.r < 0.95
ORDER BY x.paid_at;

REFRESH MATERIALIZED VIEW mv_monthly_revenue;
