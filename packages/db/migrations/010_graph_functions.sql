-- 010: SQL-еквівалент графових запитів (п. 4 завдання) над моделлю присутності з 009.
-- Семантика — packages/graph/fixtures/golden/README.md (D-24, D-25, D-30, D-33):
--   присутність враховується, якщо period && [from, to); контакт = те саме місце і period && period (межі [)).
-- Дві реалізації трасування для порівняння: «підручниковий» рекурсивний CTE з CYCLE і BFS на PL/pgSQL
-- (фронт за фронтом, кожна особа відвідується один раз).

-- ---------- BR-12 ----------
CREATE FUNCTION fn_assert_graph_query(p_kind text, p_from timestamptz, p_to timestamptz, p_depth int, p_max_depth int)
RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('patient', 'staff') THEN
    RAISE EXCEPTION 'Невідомий тип особи: % (patient / staff)', p_kind USING ERRCODE = 'P0083';
  END IF;
  IF p_depth IS NULL OR p_depth < 1 OR p_depth > p_max_depth THEN
    RAISE EXCEPTION 'Глибина має бути від 1 до %', p_max_depth USING ERRCODE = 'P0080';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RAISE EXCEPTION 'Кінець вікна має бути пізніше за початок' USING ERRCODE = 'P0081';
  END IF;
  IF p_to - p_from > interval '90 days' THEN
    RAISE EXCEPTION 'Вікно не довше 90 днів' USING ERRCODE = 'P0082';
  END IF;
END $$;

-- ---------- один крок: контакти множини осіб у вікні ----------
-- Ті самі факти, що й v_presence, але по джерелах: особа → її присутності (індекси за особою) → хто ще був у
-- тому самому місці в перетині інтервалів (GiST «місце + період» з 009). Планувальник не проштовхує параметризовані
-- умови крізь UNION ALL-view з обчислюваними колонками, тому для малих фронтів BFS кроки написано явно.
-- presences of one person in the window, per source (index lookups by person)
CREATE FUNCTION fn_person_presence(p_kind text, p_id int, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (place_kind text, place_id int, f timestamptz, t timestamptz, period tstzrange)
LANGUAGE sql STABLE AS $$
  SELECT 'room', b.room_id, a.admitted_at, coalesce(a.discharged_at, 'infinity'), tstzrange(a.admitted_at, a.discharged_at)
  FROM admissions a JOIN beds b ON b.id = a.bed_id
  WHERE p_kind = 'patient' AND a.patient_id = p_id AND tstzrange(a.admitted_at, a.discharged_at) && tstzrange(p_from, p_to)
  UNION ALL
  SELECT 'ward', b.ward_id, a.admitted_at, coalesce(a.discharged_at, 'infinity'), tstzrange(a.admitted_at, a.discharged_at)
  FROM admissions a JOIN beds b ON b.id = a.bed_id
  WHERE p_kind = 'patient' AND a.patient_id = p_id AND tstzrange(a.admitted_at, a.discharged_at) && tstzrange(p_from, p_to)
  UNION ALL
  SELECT 'office', ap.doctor_id, ap.starts_at, ap.ends_at, tstzrange(ap.starts_at, ap.ends_at)
  FROM appointments ap
  WHERE p_kind = 'patient' AND ap.patient_id = p_id AND ap.status NOT IN ('cancelled', 'no_show')
    AND tstzrange(ap.starts_at, ap.ends_at) && tstzrange(p_from, p_to)
  UNION ALL
  SELECT 'ward', s.ward_id, s.starts_at, s.ends_at, tstzrange(s.starts_at, s.ends_at)
  FROM staff_shifts s
  WHERE p_kind = 'staff' AND s.staff_id = p_id AND tstzrange(s.starts_at, s.ends_at) && tstzrange(p_from, p_to)
  UNION ALL
  SELECT 'office', ap.doctor_id, ap.starts_at, ap.ends_at, tstzrange(ap.starts_at, ap.ends_at)
  FROM staff st JOIN appointments ap ON ap.doctor_id = st.doctor_id
  WHERE p_kind = 'staff' AND st.id = p_id AND ap.status NOT IN ('cancelled', 'no_show')
    AND tstzrange(ap.starts_at, ap.ends_at) && tstzrange(p_from, p_to)
$$;

-- who is in a place during [p_f, p_t) ∩ window, per source (GiST lookups by place + period)
CREATE FUNCTION fn_place_presence(p_place_kind text, p_place_id int, p_period tstzrange, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (person_kind text, person_id int, f timestamptz, t timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT 'patient', a.patient_id, a.admitted_at, coalesce(a.discharged_at, 'infinity')
  FROM beds b JOIN admissions a ON a.bed_id = b.id
  WHERE p_place_kind = 'room' AND b.room_id = p_place_id
    AND tstzrange(a.admitted_at, a.discharged_at) && p_period AND tstzrange(a.admitted_at, a.discharged_at) && tstzrange(p_from, p_to)
  UNION ALL
  SELECT 'patient', a.patient_id, a.admitted_at, coalesce(a.discharged_at, 'infinity')
  FROM beds b JOIN admissions a ON a.bed_id = b.id
  WHERE p_place_kind = 'ward' AND b.ward_id = p_place_id
    AND tstzrange(a.admitted_at, a.discharged_at) && p_period AND tstzrange(a.admitted_at, a.discharged_at) && tstzrange(p_from, p_to)
  UNION ALL
  SELECT 'staff', s.staff_id, s.starts_at, s.ends_at
  FROM staff_shifts s
  WHERE p_place_kind = 'ward' AND s.ward_id = p_place_id
    AND tstzrange(s.starts_at, s.ends_at) && p_period AND tstzrange(s.starts_at, s.ends_at) && tstzrange(p_from, p_to)
  UNION ALL
  SELECT 'patient', ap.patient_id, ap.starts_at, ap.ends_at
  FROM appointments ap
  WHERE p_place_kind = 'office' AND ap.doctor_id = p_place_id AND ap.status NOT IN ('cancelled', 'no_show')
    AND tstzrange(ap.starts_at, ap.ends_at) && p_period AND tstzrange(ap.starts_at, ap.ends_at) && tstzrange(p_from, p_to)
  UNION ALL
  SELECT 'staff', st.id, ap.starts_at, ap.ends_at
  FROM appointments ap JOIN staff st ON st.doctor_id = ap.doctor_id
  WHERE p_place_kind = 'office' AND ap.doctor_id = p_place_id AND ap.status NOT IN ('cancelled', 'no_show')
    AND tstzrange(ap.starts_at, ap.ends_at) && p_period AND tstzrange(ap.starts_at, ap.ends_at) && tstzrange(p_from, p_to)
$$;

CREATE FUNCTION fn_presence_contacts(p_kinds text[], p_ids int[], p_from timestamptz, p_to timestamptz)
RETURNS TABLE (src_kind text, src_id int, dst_kind text, dst_id int, place_kind text, place_id int,
               ov_from timestamptz, ov_to timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT q.kind, q.id, y.person_kind, y.person_id, x.place_kind, x.place_id,
         greatest(x.f, y.f, p_from), least(x.t, y.t, p_to)
  FROM unnest(p_kinds, p_ids) AS q (kind, id)
  CROSS JOIN LATERAL fn_person_presence(q.kind, q.id, p_from, p_to) x
  CROSS JOIN LATERAL fn_place_presence(x.place_kind, x.place_id, x.period, p_from, p_to) y
  WHERE NOT (y.person_kind = q.kind AND y.person_id = q.id)
$$;

-- ---------- трасування: рекурсивний CTE з CYCLE (F-35, «як написав би SQL-розробник») ----------
-- CYCLE не дає повернутися до особи вже на шляху, але різні шляхи до однієї особи не зливаються —
-- кількість проміжних рядків росте з глибиною (саме це вимірює S1).
CREATE FUNCTION fn_trace_contacts_cte(p_person_kind text, p_person_id int, p_from timestamptz, p_to timestamptz,
                                      p_depth int)
RETURNS TABLE (person_kind text, person_id int, hops int)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  PERFORM fn_assert_graph_query(p_person_kind, p_from, p_to, p_depth, 5);
  RETURN QUERY
  WITH RECURSIVE pres AS MATERIALIZED (
    SELECT v.person_kind, v.person_id, v.place_kind, v.place_id, v.period
    FROM v_presence v
    WHERE v.period && tstzrange(p_from, p_to)
  ),
  walk (kind, id, h) AS (
    SELECT p_person_kind, p_person_id, 0
    UNION ALL
    SELECT y.person_kind, y.person_id, w.h + 1
    FROM walk w
    JOIN pres x ON x.person_kind = w.kind AND x.person_id = w.id
    JOIN pres y ON y.place_kind = x.place_kind AND y.place_id = x.place_id AND y.period && x.period
               AND NOT (y.person_kind = x.person_kind AND y.person_id = x.person_id)
    WHERE w.h < p_depth
  ) CYCLE kind, id SET is_cycle USING path
  SELECT w.kind, w.id, min(w.h)::int
  FROM walk w
  WHERE NOT w.is_cycle AND NOT (w.kind = p_person_kind AND w.id = p_person_id)
  GROUP BY w.kind, w.id;
END $$;

-- ---------- BFS (спільне ядро трасування і пошуку шляху) ----------
-- Заповнює сесійну тимчасову таблицю _graph_bfs: кожна досяжна особа один раз, з мінімальним hops і одним
-- детермінованим «свідком» (ребро, яким її досягнуто): room > office > ward, далі найменший батько, місце, час.
-- Кожен рівень — один set-based запит. Малий фронт (≤ 32 особи, clinic.bfs_small_frontier) — індексні кроки fn_presence_contacts;
-- великий — присутності вікна матеріалізуються ОДИН раз (сирі факти, не ребра-контакти: D-24) у тимчасову
-- таблицю з індексами, і рівень — hash / index join по ній.
-- p_target_*: зупинитися, щойно ціль досягнуто (пошук шляху).
CREATE FUNCTION fn_graph_bfs(p_person_kind text, p_person_id int, p_from timestamptz, p_to timestamptz, p_depth int,
                             p_target_kind text DEFAULT NULL, p_target_id int DEFAULT NULL)
RETURNS int -- досягнута глибина
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  -- порог переходу на матеріалізоване вікно; налаштування сесії clinic.bfs_small_frontier (тести: 0 = завжди вікно)
  c_small  constant int := coalesce(nullif(current_setting('clinic.bfs_small_frontier', true), '')::int, 32);
  v_level  int := 0;
  v_kinds  text[] := ARRAY[p_person_kind];
  v_ids    int[] := ARRAY[p_person_id];
  v_found  boolean := false;
  v_window boolean := false; -- _graph_pres заповнено для цього виклику
BEGIN
  IF to_regclass('pg_temp._graph_bfs') IS NULL THEN
    CREATE TEMP TABLE _graph_bfs (
      kind text NOT NULL, id int NOT NULL, hops int NOT NULL, parent_kind text, parent_id int, exposure text,
      place_id int, ov_from timestamptz, ov_to timestamptz, PRIMARY KEY (kind, id));
    CREATE TEMP TABLE _graph_pres (
      person_kind text, person_id int, place_kind text, place_id int, f timestamptz, t timestamptz, period tstzrange);
    CREATE INDEX ON _graph_pres (person_id, person_kind);
    CREATE INDEX ON _graph_pres (place_id, place_kind);
  END IF;
  TRUNCATE _graph_bfs;

  -- індексна особа (hops 0) лише якщо вона присутня у вікні; інакше відповідь порожня
  IF NOT EXISTS (SELECT 1 FROM fn_person_presence(p_person_kind, p_person_id, p_from, p_to)) THEN
    RETURN 0;
  END IF;
  INSERT INTO _graph_bfs (kind, id, hops) VALUES (p_person_kind, p_person_id, 0);

  WHILE v_level < p_depth AND cardinality(v_ids) > 0 AND NOT v_found LOOP
    v_level := v_level + 1;
    IF cardinality(v_ids) <= c_small THEN
      INSERT INTO _graph_bfs (kind, id, hops, parent_kind, parent_id, exposure, place_id, ov_from, ov_to)
      SELECT DISTINCT ON (c.dst_kind, c.dst_id)
             c.dst_kind, c.dst_id, v_level, c.src_kind, c.src_id, c.place_kind, c.place_id, c.ov_from, c.ov_to
      FROM fn_presence_contacts(v_kinds, v_ids, p_from, p_to) c
      WHERE NOT EXISTS (SELECT 1 FROM _graph_bfs b WHERE b.kind = c.dst_kind AND b.id = c.dst_id)
      ORDER BY c.dst_kind, c.dst_id, CASE c.place_kind WHEN 'room' THEN 1 WHEN 'office' THEN 2 ELSE 3 END,
               c.src_kind, c.src_id, c.place_id, c.ov_from;
    ELSE
      IF NOT v_window THEN
        TRUNCATE _graph_pres;
        INSERT INTO _graph_pres
        SELECT v.person_kind, v.person_id, v.place_kind, v.place_id, v.f, v.t, v.period
        FROM v_presence v WHERE v.period && tstzrange(p_from, p_to);
        ANALYZE _graph_pres;
        v_window := true;
      END IF;
      INSERT INTO _graph_bfs (kind, id, hops, parent_kind, parent_id, exposure, place_id, ov_from, ov_to)
      SELECT DISTINCT ON (y.person_kind, y.person_id)
             y.person_kind, y.person_id, v_level, x.person_kind, x.person_id, x.place_kind, x.place_id,
             greatest(x.f, y.f, p_from), least(x.t, y.t, p_to)
      FROM unnest(v_kinds, v_ids) AS q (kind, id)
      JOIN _graph_pres x ON x.person_id = q.id AND x.person_kind = q.kind
      JOIN _graph_pres y ON y.place_id = x.place_id AND y.place_kind = x.place_kind AND y.period && x.period
      WHERE NOT EXISTS (SELECT 1 FROM _graph_bfs b WHERE b.kind = y.person_kind AND b.id = y.person_id)
      ORDER BY y.person_kind, y.person_id, CASE x.place_kind WHEN 'room' THEN 1 WHEN 'office' THEN 2 ELSE 3 END,
               x.person_kind, x.person_id, x.place_id, greatest(x.f, y.f, p_from);
    END IF;

    SELECT coalesce(array_agg(b.kind), '{}'), coalesce(array_agg(b.id), '{}')
      INTO v_kinds, v_ids
    FROM _graph_bfs b WHERE b.hops = v_level;

    IF p_target_kind IS NOT NULL THEN
      v_found := EXISTS (SELECT 1 FROM _graph_bfs b WHERE b.kind = p_target_kind AND b.id = p_target_id);
    END IF;
  END LOOP;
  RETURN v_level;
END $$;

-- ---------- трасування: BFS (F-35) ----------
CREATE FUNCTION fn_trace_contacts(p_person_kind text, p_person_id int, p_from timestamptz, p_to timestamptz,
                                  p_depth int)
RETURNS TABLE (person_kind text, person_id int, hops int, parent_kind text, parent_id int, exposure text,
               place_id int, overlap_minutes numeric)
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM fn_assert_graph_query(p_person_kind, p_from, p_to, p_depth, 5);
  PERFORM fn_graph_bfs(p_person_kind, p_person_id, p_from, p_to, p_depth);
  RETURN QUERY
  SELECT b.kind, b.id, b.hops, b.parent_kind, b.parent_id, b.exposure, b.place_id,
         round((extract(epoch FROM b.ov_to - b.ov_from) / 60)::numeric, 1)
  FROM _graph_bfs b
  WHERE b.hops > 0
  ORDER BY b.hops, b.kind, b.id;
END $$;

-- ---------- найкоротший ланцюг експозиції (F-36) ----------
-- Рядки: особа (step 0) → місце → особа → …; місце несе перетин інтервалів (f, t). Порожньо — не пов'язані
-- в межах p_max_depth. hops = кількість рядків-осіб − 1.
CREATE FUNCTION fn_exposure_path(p_a_kind text, p_a_id int, p_b_kind text, p_b_id int, p_from timestamptz,
                                 p_to timestamptz, p_max_depth int DEFAULT 6)
RETURNS TABLE (step int, step_type text, kind text, id int, f timestamptz, t timestamptz)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_kind text := p_b_kind;
  v_id   int := p_b_id;
  v_n    int;
  r      record;
  v_rows jsonb := '[]';
BEGIN
  PERFORM fn_assert_graph_query(p_a_kind, p_from, p_to, p_max_depth, 8);
  PERFORM fn_assert_graph_query(p_b_kind, p_from, p_to, p_max_depth, 8);
  PERFORM fn_graph_bfs(p_a_kind, p_a_id, p_from, p_to, p_max_depth, p_b_kind, p_b_id);
  SELECT b.hops INTO v_n FROM _graph_bfs b WHERE b.kind = p_b_kind AND b.id = p_b_id;
  IF v_n IS NULL THEN
    RETURN;
  END IF;
  -- від цілі до джерела за батьківськими вказівниками
  LOOP
    SELECT * INTO r FROM _graph_bfs b WHERE b.kind = v_kind AND b.id = v_id;
    step := r.hops * 2; step_type := 'person'; kind := r.kind; id := r.id; f := NULL; t := NULL;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('step', step, 'type', step_type, 'kind', kind, 'id', id));
    EXIT WHEN r.hops = 0;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('step', r.hops * 2 - 1, 'type', 'place', 'kind', r.exposure,
      'id', r.place_id, 'f', r.ov_from, 't', r.ov_to));
    v_kind := r.parent_kind;
    v_id := r.parent_id;
  END LOOP;
  RETURN QUERY
  SELECT (e ->> 'step')::int, e ->> 'type', e ->> 'kind', (e ->> 'id')::int,
         (e ->> 'f')::timestamptz, (e ->> 't')::timestamptz
  FROM jsonb_array_elements(v_rows) e
  ORDER BY 1;
END $$;

-- ---------- взаємодії ліків (F-37, D-33) ----------
CREATE FUNCTION fn_patient_active_medications(p_patient_id int, p_at timestamptz DEFAULT now())
RETURNS TABLE (medication_id int)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT tk.medication_id
  FROM v_takes tk
  WHERE tk.patient_id = p_patient_id AND tk.f <= p_at AND p_at < tk.t
$$;

CREATE FUNCTION fn_drug_interactions(p_medication_ids int[], p_patient_id int DEFAULT NULL, p_at timestamptz DEFAULT now())
RETURNS TABLE (medication_a int, medication_b int, severity interaction_severity, via text, class_a int, class_b int)
LANGUAGE sql STABLE AS $$
  WITH new_m AS (SELECT DISTINCT u.id FROM unnest(p_medication_ids) AS u (id)),
  cur_m AS (SELECT am.medication_id AS id FROM fn_patient_active_medications(p_patient_id, coalesce(p_at, now())) am
            WHERE p_patient_id IS NOT NULL),
  all_m AS (SELECT id FROM new_m UNION SELECT id FROM cur_m),
  pairs AS (
    SELECT a.id AS a, b.id AS b
    FROM all_m a JOIN all_m b ON a.id < b.id
    WHERE a.id IN (SELECT id FROM new_m) OR b.id IN (SELECT id FROM new_m)
  )
  SELECT p.a, p.b, mi.severity, 'direct', NULL::int, NULL::int
  FROM pairs p
  JOIN medication_interactions mi ON mi.medication_a = p.a AND mi.medication_b = p.b
  UNION ALL
  SELECT p.a, p.b, ci.severity, 'class', ca.class_id, cb.class_id
  FROM pairs p
  JOIN medication_classes ca ON ca.medication_id = p.a
  JOIN medication_classes cb ON cb.medication_id = p.b
  JOIN drug_class_interactions ci ON ci.class_a = least(ca.class_id, cb.class_id)
                                 AND ci.class_b = greatest(ca.class_id, cb.class_id)
$$;

-- ---------- плоский агрегат (S5: тут граф не має переваги) ----------
CREATE FUNCTION fn_admissions_by_dept_month(p_from date, p_to date)
RETURNS TABLE (department_id int, month date, admissions int)
LANGUAGE sql STABLE AS $$
  SELECT w.department_id, date_trunc('month', a.admitted_at)::date, count(*)::int
  FROM admissions a
  JOIN beds b ON b.id = a.bed_id
  JOIN wards w ON w.id = b.ward_id
  WHERE a.admitted_at >= p_from AND a.admitted_at < p_to
  GROUP BY 1, 2
  ORDER BY 1, 2
$$;

CREATE INDEX ix_admissions_admitted_at ON admissions (admitted_at);

COMMENT ON FUNCTION fn_trace_contacts_cte IS 'F-35: трасування рекурсивним CTE з CYCLE — (особа, мінімальні кроки)';
COMMENT ON FUNCTION fn_trace_contacts IS 'F-35: трасування BFS (PL/pgSQL) — особа, мінімальні кроки, ребро-свідок';
COMMENT ON FUNCTION fn_exposure_path IS 'F-36: найкоротший ланцюг особа → місце → особа між двома особами у вікні';
COMMENT ON FUNCTION fn_drug_interactions IS 'F-37: взаємодії ліків напряму і через класи (D-33)';
COMMENT ON FUNCTION fn_admissions_by_dept_month IS 'S5: госпіталізації по відділеннях і місяцях';
