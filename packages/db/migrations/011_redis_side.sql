-- 011: Лаб 2 — PostgreSQL-сторона задач Redis (docs/06 §3, §5).
-- 1) triage_queue_pg + fn_triage_pop — еталон черги тріажу на FOR UPDATE SKIP LOCKED (бенчмарк R3; сама черга
--    застосунку живе лише в Redis, BR-14).
-- 2) icu_alerts + sp_icu_alert_record — довготривале зберігання критичних алертів ICU (F-44); споживач групи
--    Redis Stream пише сюди ідемпотентно за stream id.
-- 3) icu_vitals_pg + sp_icu_vitals_insert — еталон інжесту показників у PG з тією самою перевіркою BR-17 (R4).
-- Аудит-тригери (tf_set_audit_fields / tf_audit_log) на ці таблиці НЕ ставляться: записи генерують пристрої та
-- воркери (автора-користувача немає), а частота (1 показник/с на ліжко) подвоїла б кожен запис рядком audit_log.

-- ---------- BR-17: пороги критичних показників — одне визначення для PG (тут) і Lua (packages/redis/src/icu-script.ts) ----------
CREATE FUNCTION fn_icu_violations(p_hr numeric, p_spo2 numeric, p_sbp numeric, p_dbp numeric, p_rr numeric, p_temp numeric)
RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('sign', v.sign, 'value', v.value, 'rule', v.rule) ORDER BY v.ord), '[]'::jsonb)
  FROM (VALUES
    (1, 'hr', p_hr, '< 40', p_hr < 40),
    (2, 'hr', p_hr, '> 140', p_hr > 140),
    (3, 'spo2', p_spo2, '< 88', p_spo2 < 88),
    (4, 'sbp', p_sbp, '< 80', p_sbp < 80),
    (5, 'sbp', p_sbp, '> 200', p_sbp > 200),
    (6, 'rr', p_rr, '< 8', p_rr < 8),
    (7, 'rr', p_rr, '> 30', p_rr > 30),
    (8, 'temp', p_temp, '> 39.5', p_temp > 39.5)
  ) AS v (ord, sign, value, rule, hit)
  WHERE v.hit
$$;
-- p_dbp не має порогу в BR-17; параметр лишається, щоб сигнатура відповідала повному набору показників.

-- ---------- черга тріажу: еталон PG ----------
CREATE TABLE triage_queue_pg (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id   int REFERENCES patients (id),
  patient_name text NOT NULL CONSTRAINT ck_triage_queue_pg_name CHECK (btrim(patient_name) <> ''),
  esi          smallint NOT NULL CONSTRAINT ck_triage_queue_pg_esi CHECK (esi BETWEEN 1 AND 5),
  complaint    text NOT NULL,
  arrived_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  called_at    timestamptz
);
-- Порядок виклику (BR-14): ESI за зростанням, потім час прибуття; id — детермінований tie-break
CREATE INDEX ix_triage_queue_pg_waiting ON triage_queue_pg (esi, arrived_at, id) WHERE called_at IS NULL;
COMMENT ON TABLE triage_queue_pg IS 'Еталон черги тріажу в PG (FOR UPDATE SKIP LOCKED) для порівняння з Redis ZPOPMIN (R3)';

CREATE PROCEDURE sp_triage_add(p_patient_id int, p_patient_name text, p_esi int, p_complaint text,
                               INOUT p_id bigint DEFAULT NULL)
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO triage_queue_pg (patient_id, patient_name, esi, complaint)
  VALUES (p_patient_id, p_patient_name, p_esi, p_complaint)
  RETURNING id INTO p_id;
END $$;

-- Видати наступного рівно один раз: рядки, заблоковані іншими споживачами, пропускаються (SKIP LOCKED).
-- Функція, а не процедура, бо повертає рядок; викликається лише бенчмарком і тестами (не apps/api).
CREATE FUNCTION fn_triage_pop() RETURNS SETOF triage_queue_pg
LANGUAGE sql VOLATILE AS $$
  UPDATE triage_queue_pg t SET called_at = clock_timestamp()
  WHERE t.id = (
    SELECT q.id FROM triage_queue_pg q
    WHERE q.called_at IS NULL
    ORDER BY q.esi, q.arrived_at, q.id
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING t.*
$$;

-- ---------- ICU: збережені алерти ----------
CREATE TABLE icu_alerts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stream_id   text NOT NULL CONSTRAINT ux_icu_alerts_stream UNIQUE, -- id запису Redis Stream (або 'pg:<id>' для R4)
  bed_id      int NOT NULL REFERENCES beds (id),
  patient_id  int REFERENCES patients (id),
  violations  jsonb NOT NULL CONSTRAINT ck_icu_alerts_violations CHECK (jsonb_typeof(violations) = 'array' AND jsonb_array_length(violations) > 0),
  vitals      jsonb NOT NULL,
  at          timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_icu_alerts_at ON icu_alerts (at DESC);
CREATE INDEX ix_icu_alerts_bed ON icu_alerts (bed_id, at DESC);
CREATE INDEX ix_icu_alerts_patient ON icu_alerts (patient_id);
COMMENT ON TABLE icu_alerts IS 'Критичні алерти ICU (BR-17), збережені з Redis Stream; stream_id унікальний → повторна доставка не дублює';

-- Ідемпотентно: повтор того самого stream id → p_id = NULL. Пацієнт за замовчуванням — активна госпіталізація ліжка.
CREATE PROCEDURE sp_icu_alert_record(p_stream_id text, p_bed_id int, p_patient_id int, p_violations jsonb,
                                     p_vitals jsonb, p_at timestamptz, INOUT p_id bigint DEFAULT NULL)
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO icu_alerts (stream_id, bed_id, patient_id, violations, vitals, at)
  VALUES (p_stream_id, p_bed_id,
          coalesce(p_patient_id, (SELECT a.patient_id FROM admissions a WHERE a.bed_id = p_bed_id AND a.status = 'active')),
          p_violations, p_vitals, p_at)
  ON CONFLICT (stream_id) DO NOTHING
  RETURNING id INTO p_id;
END $$;

-- ---------- ICU: показники в PG (еталон R4) ----------
CREATE TABLE icu_vitals_pg (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bed_id int NOT NULL REFERENCES beds (id),
  at     timestamptz NOT NULL,
  hr     real NOT NULL,
  spo2   real NOT NULL,
  sbp    real NOT NULL,
  dbp    real NOT NULL,
  rr     real NOT NULL,
  temp   real NOT NULL
);
CREATE INDEX ix_icu_vitals_pg_bed_at ON icu_vitals_pg (bed_id, at DESC); -- «останні показники ліжка»
CREATE INDEX ix_icu_vitals_pg_at ON icu_vitals_pg USING brin (at);     -- хронологічний архів
COMMENT ON TABLE icu_vitals_pg IS 'Показники ICU в PG — еталон для порівняння з Redis Stream + Lua (R4)';

-- Один показник: вставка + перевірка BR-17 + алерт + NOTIFY (аналог PUBLISH) — те саме, що робить Lua-скрипт Redis
CREATE PROCEDURE sp_icu_vitals_insert(p_bed_id int, p_at timestamptz, p_hr numeric, p_spo2 numeric, p_sbp numeric, p_dbp numeric,
                                      p_rr numeric, p_temp numeric, INOUT p_violations jsonb DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE
  v_id    bigint;
  v_alert bigint;
BEGIN
  INSERT INTO icu_vitals_pg (bed_id, at, hr, spo2, sbp, dbp, rr, temp)
  VALUES (p_bed_id, p_at, p_hr, p_spo2, p_sbp, p_dbp, p_rr, p_temp)
  RETURNING id INTO v_id;
  p_violations := fn_icu_violations(p_hr, p_spo2, p_sbp, p_dbp, p_rr, p_temp);
  IF jsonb_array_length(p_violations) > 0 THEN
    CALL sp_icu_alert_record('pg:' || v_id, p_bed_id, NULL, p_violations,
      jsonb_build_object('hr', p_hr, 'spo2', p_spo2, 'sbp', p_sbp, 'dbp', p_dbp, 'rr', p_rr, 'temp', p_temp, 'at', p_at),
      p_at, v_alert);
    PERFORM pg_notify('icu_alerts', jsonb_build_object('id', v_alert, 'bedId', p_bed_id, 'violations', p_violations)::text);
  END IF;
END $$;

-- ---------- view для API ----------
CREATE VIEW v_icu_beds AS
SELECT b.id AS bed_id, b.bed_number, b.ward_id, b.ward_number, b.status, b.admission_id, b.patient_id, b.patient_name
FROM v_beds b
WHERE b.ward_type = 'icu';

CREATE VIEW v_icu_alerts AS
SELECT al.id AS alert_id, al.stream_id, al.bed_id, b.bed_number, w.id AS ward_id, w.ward_number,
       al.patient_id, CASE WHEN p.id IS NOT NULL THEN fn_full_name(p.last_name, p.first_name, p.middle_name) END AS patient_name,
       al.violations, al.vitals, al.at, al.recorded_at
FROM icu_alerts al
JOIN beds b ON b.id = al.bed_id
JOIN wards w ON w.id = b.ward_id
LEFT JOIN patients p ON p.id = al.patient_id;
