-- 04: Лаб 2 — персонал (лікарі + медсестри), ротація змін навколо поточної дати, фармакологічні класи,
-- взаємодії. Кімнати для довідникових ліжок створює тригер trg_beds_default_room (009, D-21).
-- Бенчмарк-обсяги генерує окремий генератор (packages/graph/gen) у бази clinic_bench_x*.

SELECT set_config('app.current_user_id', (SELECT id::text FROM users WHERE email = 'admin@clinic.local'), true);

-- ---------- персонал ----------
INSERT INTO staff (full_name, role, doctor_id, department_id)
SELECT u.full_name, 'doctor', d.id, d.department_id
FROM doctors d JOIN users u ON u.id = d.user_id
ORDER BY d.id;

-- 4 медсестри на відділення; кожна четверта — «плаваюча» (зміни в різних палатах відділення)
INSERT INTO staff (full_name, role, department_id, is_float)
SELECT (ARRAY['Гнатюк', 'Сорока', 'Ярошенко', 'Кушнір', 'Білик', 'Дмитренко'])[1 + (dep.rn - 1) % 6] || ' ' ||
       (ARRAY['Оксана', 'Галина', 'Ірина', 'Леся'])[k] || ' (медсестра)',
       'nurse', dep.id, k = 4
FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM departments) dep
CROSS JOIN generate_series(1, 4) k
ORDER BY dep.id, k;

-- ---------- зміни: 28 днів назад … 7 днів уперед ----------
-- Медсестри: цикл 8 днів 2Д-2В-2Н-2 вихідні (Д 07–15, В 15–23, Н 23–07), зсув циклу = номер медсестри × 2
INSERT INTO staff_shifts (staff_id, ward_id, starts_at, ends_at)
SELECT n.id, w.ids[1 + CASE WHEN n.is_float THEN (x.day - (current_date - 28)) ELSE n.k - 1 END % array_length(w.ids, 1)],
       x.day + make_interval(hours => x.start_h), x.day + make_interval(hours => x.start_h + 8)
FROM (SELECT s.*, row_number() OVER (PARTITION BY s.department_id ORDER BY s.id)::int AS k
      FROM staff s WHERE s.role = 'nurse') n
JOIN (SELECT department_id, array_agg(id ORDER BY id) AS ids FROM wards GROUP BY department_id) w
  ON w.department_id = n.department_id
CROSS JOIN LATERAL (
  SELECT day::date AS day,
         (ARRAY[7, 7, 15, 15, 23, 23, NULL, NULL])[1 + ((day::date - (current_date - 28)) + n.k * 2) % 8] AS start_h
  FROM generate_series(current_date - 28, current_date + 7, interval '1 day') day
) x
WHERE x.start_h IS NOT NULL;

-- Лікарі: палатна зміна 08–16 у будні в першій палаті свого відділення
INSERT INTO staff_shifts (staff_id, ward_id, starts_at, ends_at)
SELECT s.id, w.first_ward, day::date + time '08:00', day::date + time '16:00'
FROM staff s
JOIN (SELECT department_id, min(id) AS first_ward FROM wards GROUP BY department_id) w ON w.department_id = s.department_id
CROSS JOIN generate_series(current_date - 28, current_date + 7, interval '1 day') day
WHERE s.role = 'doctor' AND extract(isodow FROM day) <= 5;

-- ---------- фармакологічні класи ----------
INSERT INTO drug_classes (code, name) VALUES
  ('NSAID', 'Нестероїдні протизапальні засоби'),
  ('ANALG', 'Ненаркотичні анальгетики'),
  ('PEN', 'Пеніциліни'),
  ('MACRO', 'Макроліди'),
  ('CEPH', 'Цефалоспорини'),
  ('AMINOGLY', 'Аміноглікозиди'),
  ('BIGUAN', 'Бігуаніди'),
  ('INSULIN', 'Інсуліни'),
  ('ACEI', 'Інгібітори АПФ'),
  ('CCB', 'Блокатори кальцієвих каналів'),
  ('BB', 'Бета-адреноблокатори'),
  ('STATIN', 'Статини'),
  ('ANTIPLT', 'Антиагреганти'),
  ('LMWH', 'Низькомолекулярні гепарини'),
  ('PPI', 'Інгібітори протонної помпи'),
  ('AH', 'Антигістамінні'),
  ('SABA', 'Бета-2-агоністи короткої дії'),
  ('CORT', 'Кортикостероїди'),
  ('MUCO', 'Муколітики'),
  ('THYR', 'Гормони щитоподібної залози'),
  ('BZD', 'Бензодіазепіни'),
  ('LOOP', 'Петльові діуретики'),
  ('ELECTR', 'Електроліти'),
  ('NOOTR', 'Ноотропи');

INSERT INTO medication_classes (medication_id, class_id)
SELECT m.id, c.id
FROM (VALUES
  ('Парацетамол', 'ANALG'), ('Ібупрофен', 'NSAID'), ('Декскетопрофен', 'NSAID'),
  ('Ацетилсаліцилова кислота', 'NSAID'), ('Ацетилсаліцилова кислота', 'ANTIPLT'), ('Клопідогрел', 'ANTIPLT'),
  ('Амоксицилін', 'PEN'), ('Амоксицилін + клавуланова кислота', 'PEN'), ('Азитроміцин', 'MACRO'),
  ('Цефтріаксон', 'CEPH'), ('Тобраміцин', 'AMINOGLY'), ('Метформін', 'BIGUAN'), ('Інсулін гларгін', 'INSULIN'),
  ('Лізиноприл', 'ACEI'), ('Амлодипін', 'CCB'), ('Бісопролол', 'BB'), ('Метопролол', 'BB'),
  ('Аторвастатин', 'STATIN'), ('Еноксапарин', 'LMWH'), ('Омепразол', 'PPI'), ('Пантопразол', 'PPI'),
  ('Лоратадин', 'AH'), ('Цетиризин', 'AH'), ('Сальбутамол', 'SABA'), ('Будесонід', 'CORT'),
  ('Гідрокортизон', 'CORT'), ('Амброксол', 'MUCO'), ('Левотироксин', 'THYR'), ('Діазепам', 'BZD'),
  ('Фуросемід', 'LOOP'), ('Магнію сульфат', 'ELECTR'), ('Гліцин', 'NOOTR')
) AS x (med, cls)
JOIN medications m ON m.name = x.med
JOIN drug_classes c ON c.code = x.cls;

-- ---------- взаємодії клас–клас (a <= b за id) ----------
INSERT INTO drug_class_interactions (class_a, class_b, severity, description)
SELECT least(a.id, b.id), greatest(a.id, b.id), x.sev::interaction_severity, x.descr
FROM (VALUES
  ('NSAID', 'LMWH', 'major', 'Ризик кровотечі'),
  ('ANTIPLT', 'LMWH', 'major', 'Ризик кровотечі'),
  ('NSAID', 'NSAID', 'moderate', 'Дублювання терапії, шлунково-кишкова токсичність'),
  ('NSAID', 'ACEI', 'moderate', 'Зниження антигіпертензивного ефекту, ризик для нирок'),
  ('NSAID', 'LOOP', 'moderate', 'Зниження діуретичного ефекту'),
  ('NSAID', 'CORT', 'moderate', 'Ризик виразки'),
  ('BB', 'SABA', 'moderate', 'Взаємна нейтралізація ефекту'),
  ('BB', 'BB', 'major', 'Дублювання бета-блокади'),
  ('MACRO', 'STATIN', 'moderate', 'Міопатія (CYP3A4)'),
  ('PPI', 'PPI', 'minor', 'Дублювання терапії'),
  ('INSULIN', 'BB', 'minor', 'Маскування гіпоглікемії'),
  ('AMINOGLY', 'LOOP', 'major', 'Ото- та нефротоксичність'),
  ('BZD', 'ELECTR', 'minor', 'Посилення седації')
) AS x (ca, cb, sev, descr)
JOIN drug_classes a ON a.code = x.ca
JOIN drug_classes b ON b.code = x.cb;

-- ---------- взаємодії препарат–препарат (a < b за id) ----------
INSERT INTO medication_interactions (medication_a, medication_b, severity, description)
SELECT least(a.id, b.id), greatest(a.id, b.id), x.sev::interaction_severity, x.descr
FROM (VALUES
  ('Клопідогрел', 'Омепразол', 'moderate', 'Омепразол знижує активацію клопідогрелу (CYP2C19)'),
  ('Ацетилсаліцилова кислота', 'Ібупрофен', 'moderate', 'Ібупрофен послаблює антиагрегантну дію аспірину'),
  ('Метформін', 'Фуросемід', 'minor', 'Зміна рівня глюкози'),
  ('Левотироксин', 'Омепразол', 'minor', 'Зниження всмоктування левотироксину'),
  ('Клопідогрел', 'Еноксапарин', 'major', 'Ризик кровотечі')
) AS x (ma, mb, sev, descr)
JOIN medications a ON a.name = x.ma
JOIN medications b ON b.name = x.mb;
