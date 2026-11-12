-- Golden fixture (W0): маленький граф, відповіді на який пораховано ВРУЧНУ (README.md → expected.json)
-- ДО появи коду рушіїв. Завантажується в щойно змігровану базу БЕЗ seed-ів (migrate only).
-- Час — UTC; вікно за замовчуванням W = [2026-03-01T00:00Z, 2026-03-15T00:00Z).
-- Ідентифікатори явні: P# = patients.id, S# = staff.id, M# = medications.id, C# = drug_classes.id.

SET timezone = 'UTC';

INSERT INTO roles (id, code, name) VALUES (1, 'doctor', 'Лікар');
INSERT INTO users (id, email, password_hash, role_id, full_name) VALUES
  (1, 'g.doc1@clinic.local', 'x', 1, 'Лікар Перший'),
  (2, 'g.doc2@clinic.local', 'x', 1, 'Лікар Другий');
INSERT INTO specializations (id, name) VALUES (1, 'Терапевт');
INSERT INTO departments (id, name) VALUES (1, 'Відділення 1'), (2, 'Відділення 2');
INSERT INTO doctors (id, user_id, department_id, specialization_id, license_number) VALUES
  (1, 1, 1, 1, 'G-1'), (2, 2, 2, 1, 'G-2');

-- Палати W1, W2 (відділення 1), W3 (відділення 2)
INSERT INTO wards (id, department_id, ward_number, ward_type, capacity, daily_rate) VALUES
  (1, 1, 'W1', 'general', 3, 100), (2, 1, 'W2', 'general', 2, 100), (3, 2, 'W3', 'general', 2, 100);
-- Кімнати: R11 = 1, R12 = 2 (W1); R21 = 3 (W2); R31 = 4 (W3)
INSERT INTO rooms (id, ward_id, room_number) VALUES (1, 1, 'R11'), (2, 1, 'R12'), (3, 2, 'R21'), (4, 3, 'R31');
-- Ліжка: 1,2 → R11; 3 → R12; 4,5 → R21; 6,7 → R31
INSERT INTO beds (id, ward_id, room_id, bed_number) VALUES
  (1, 1, 1, 'B111'), (2, 1, 1, 'B112'), (3, 1, 2, 'B121'),
  (4, 2, 3, 'B211'), (5, 2, 3, 'B212'),
  (6, 3, 4, 'B311'), (7, 3, 4, 'B312');

INSERT INTO patients (id, last_name, first_name, birth_date, sex)
SELECT i, 'Пацієнт', 'P' || i, date '1980-01-01', 'male' FROM generate_series(1, 12) i;

-- Госпіталізації (місце = кімната + палата ліжка)
INSERT INTO admissions (id, patient_id, bed_id, doctor_id, admitted_at, discharged_at, status) VALUES
  (1,  1, 1, 1, '2026-03-02T00:00Z', '2026-03-06T00:00Z', 'discharged'), -- P1  R11/W1
  (2,  2, 2, 1, '2026-03-04T00:00Z', '2026-03-08T00:00Z', 'discharged'), -- P2  R11/W1
  (3,  3, 3, 1, '2026-03-05T00:00Z', NULL,                'active'),     -- P3  R12/W1, відкрите перебування
  (4,  4, 1, 1, '2026-03-06T00:00Z', '2026-03-09T00:00Z', 'discharged'), -- P4  R11/W1, починається рівно коли P1 виписаний
  (5,  5, 4, 1, '2026-03-01T00:00Z', '2026-03-03T00:00Z', 'discharged'), -- P5  R21/W2
  (6,  6, 6, 2, '2026-02-20T00:00Z', '2026-03-01T00:00Z', 'discharged'), -- P6  R31/W3, закінчується рівно на початку W
  (7,  7, 7, 2, '2026-03-10T00:00Z', '2026-03-12T00:00Z', 'discharged'), -- P7  R31/W3
  (8,  8, 6, 2, '2026-03-14T00:00Z', '2026-03-20T00:00Z', 'discharged'), -- P8  R31/W3, виходить за кінець W
  (9,  9, 4, 1, '2026-03-15T00:00Z', '2026-03-18T00:00Z', 'discharged'), -- P9  R21/W2, починається рівно в кінці W
  (10, 10, 5, 1, '2026-03-02T00:00Z', '2026-03-04T00:00Z', 'discharged'); -- P10 R21/W2

-- Персонал: S1, S2 — лікарі 1, 2; S3, S5 — медсестри; S4 — «плаваюча» медсестра (W1 і W3)
INSERT INTO staff (id, full_name, role, doctor_id, department_id, is_float) VALUES
  (1, 'Лікар Перший', 'doctor', 1, 1, false),
  (2, 'Лікар Другий', 'doctor', 2, 2, false),
  (3, 'Медсестра S3', 'nurse', NULL, 1, false),
  (4, 'Медсестра S4', 'nurse', NULL, 1, true),
  (5, 'Медсестра S5', 'nurse', NULL, 1, false);

INSERT INTO staff_shifts (id, staff_id, ward_id, starts_at, ends_at) VALUES
  (1, 3, 1, '2026-03-05T08:00Z', '2026-03-05T20:00Z'), -- S3 W1
  (2, 4, 1, '2026-03-07T08:00Z', '2026-03-07T20:00Z'), -- S4 W1
  (3, 4, 3, '2026-03-11T08:00Z', '2026-03-11T20:00Z'), -- S4 W3
  (4, 5, 2, '2026-03-02T20:00Z', '2026-03-03T08:00Z'), -- S5 W2 (нічна)
  (5, 1, 1, '2026-03-12T08:00Z', '2026-03-12T16:00Z'), -- S1 W1
  (6, 2, 3, '2026-03-14T08:00Z', '2026-03-14T16:00Z'); -- S2 W3

-- Прийоми (місце = кабінет лікаря, office id = doctors.id; лікар присутній на час прийому)
INSERT INTO appointments (id, patient_id, doctor_id, starts_at, ends_at, status) VALUES
  (1, 11, 1, '2026-03-03T10:00Z', '2026-03-03T10:30Z', 'completed'),
  (2, 12, 1, '2026-03-03T10:30Z', '2026-03-03T11:00Z', 'completed'), -- впритул до прийому 1: P11 і P12 не перетинаються
  (3,  5, 2, '2026-03-05T09:00Z', '2026-03-05T09:30Z', 'cancelled'), -- не враховується
  (4,  7, 2, '2026-03-13T09:00Z', '2026-03-13T09:30Z', 'completed'),
  (5,  1, 2, '2026-03-01T10:00Z', '2026-03-01T10:30Z', 'no_show');   -- не враховується

-- ---------- препарати, класи, взаємодії ----------
INSERT INTO medications (id, name, form, strength) VALUES
  (1, 'Варфарин', 'tablet', '5 мг'),
  (2, 'Аспірин', 'tablet', '100 мг'),
  (3, 'Ібупрофен', 'tablet', '400 мг'),
  (4, 'Напроксен', 'tablet', '250 мг'),
  (5, 'Омепразол', 'capsule', '20 мг'),
  (6, 'Клопідогрел', 'tablet', '75 мг'),
  (7, 'Парацетамол', 'tablet', '500 мг'); -- без класу і взаємодій

INSERT INTO drug_classes (id, code, name) VALUES
  (1, 'ANTICOAG', 'Антикоагулянти'), (2, 'NSAID', 'НПЗЗ'), (3, 'ANTIPLT', 'Антиагреганти'), (4, 'PPI', 'ІПП');

INSERT INTO medication_classes (medication_id, class_id) VALUES
  (1, 1), (2, 2), (2, 3), (3, 2), (4, 2), (5, 4), (6, 3);

INSERT INTO medication_interactions (medication_a, medication_b, severity) VALUES
  (1, 2, 'major'), (5, 6, 'moderate');

INSERT INTO drug_class_interactions (class_a, class_b, severity) VALUES
  (1, 2, 'major'), (1, 3, 'major'), (2, 2, 'moderate');

-- Рецепт P2 (у межах госпіталізації 2): Варфарин 30 днів, Парацетамол 3 дні від 2026-03-04T10:00Z
INSERT INTO medical_records (id, admission_id, patient_id, doctor_id, conclusion) VALUES (1, 2, 2, 1, 'Golden');
INSERT INTO prescriptions (id, medical_record_id, issued_at) VALUES (1, 1, '2026-03-04T10:00Z');
INSERT INTO prescription_items (id, prescription_id, medication_id, dosage, frequency, duration_days, quantity) VALUES
  (1, 1, 1, '5 мг', '1 раз на день', 30, 30),
  (2, 1, 7, '500 мг', '3 рази на день', 3, 9);

-- Наступні id не перетинаються з фікстурою (тести можуть додавати рядки)
SELECT setval(pg_get_serial_sequence(t, 'id'), 1000)
FROM unnest(ARRAY['roles', 'users', 'specializations', 'departments', 'doctors', 'wards', 'rooms', 'beds', 'patients',
                  'admissions', 'staff', 'staff_shifts', 'appointments', 'medications', 'drug_classes',
                  'medication_classes', 'medication_interactions', 'drug_class_interactions', 'medical_records',
                  'prescriptions', 'prescription_items']) t;
