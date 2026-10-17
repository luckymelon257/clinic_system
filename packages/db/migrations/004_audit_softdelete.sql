-- 004: механізм аудиту та soft delete (docs/02-sql-objects.md §1)

-- Поточний користувач, переданий з коду: SELECT set_config('app.current_user_id', $1, true)
CREATE FUNCTION fn_current_user_id() RETURNS int
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.current_user_id', true), '')::int
$$;

-- BEFORE INSERT/UPDATE: created_* при вставці, updated_* при оновленні; created_* змінювати заборонено
CREATE FUNCTION tf_set_audit_fields() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := coalesce(NEW.created_at, now()); -- seed може передати історичну дату
    NEW.created_by := fn_current_user_id();
    NEW.updated_at := NULL;
    NEW.updated_by := NULL;
  ELSE
    IF NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'Поля created_at / created_by змінювати заборонено (%)', TG_TABLE_NAME
        USING ERRCODE = 'P0403';
    END IF;
    NEW.updated_at := now();
    NEW.updated_by := fn_current_user_id();
  END IF;
  RETURN NEW;
END $$;

-- AFTER INSERT/UPDATE/DELETE: запис у audit_log; SOFT_DELETE / RESTORE розпізнаються за зміною deleted_at
CREATE FUNCTION tf_audit_log() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_old    jsonb;
  v_new    jsonb;
  v_op     audit_operation;
  v_fields text[];
  v_at     timestamptz;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN v_old := to_jsonb(OLD) - 'password_hash'; END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') THEN v_new := to_jsonb(NEW) - 'password_hash'; END IF;

  IF TG_OP = 'INSERT' THEN
    v_op := 'INSERT';
    v_at := (v_new ->> 'created_at')::timestamptz;
  ELSIF TG_OP = 'DELETE' THEN
    v_op := 'DELETE';
    v_at := now();
  ELSE
    SELECT array_agg(n.key ORDER BY n.key) INTO v_fields
    FROM jsonb_each(v_new) n
    WHERE n.key NOT IN ('updated_at', 'updated_by') AND n.value IS DISTINCT FROM v_old -> n.key;
    IF v_fields IS NULL THEN
      RETURN NULL; -- нічого суттєвого не змінилось
    END IF;
    v_op := CASE
      WHEN v_old ? 'deleted_at' AND v_old ->> 'deleted_at' IS NULL AND v_new ->> 'deleted_at' IS NOT NULL THEN 'SOFT_DELETE'
      WHEN v_old ? 'deleted_at' AND v_old ->> 'deleted_at' IS NOT NULL AND v_new ->> 'deleted_at' IS NULL THEN 'RESTORE'
      ELSE 'UPDATE'
    END::audit_operation;
    v_at := (v_new ->> 'updated_at')::timestamptz;
  END IF;

  INSERT INTO audit_log (table_name, record_id, operation, changed_fields, old_data, new_data, changed_at, changed_by)
  VALUES (TG_TABLE_NAME, (coalesce(v_new, v_old) ->> 'id')::int, v_op, v_fields, v_old, v_new,
          coalesce(v_at, now()), fn_current_user_id());
  RETURN NULL;
END $$;

-- BEFORE DELETE: фізичне видалення → soft delete (BR-6)
CREATE FUNCTION tf_soft_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NULL THEN
    EXECUTE format('UPDATE %I.%I SET deleted_at = now(), deleted_by = fn_current_user_id() WHERE id = $1',
                   TG_TABLE_SCHEMA, TG_TABLE_NAME)
      USING OLD.id;
  END IF;
  RETURN NULL; -- скасовує фізичне видалення
END $$;

-- BEFORE DELETE: медичні документи та оплати не видаляються (BR-5, F-21)
CREATE FUNCTION tf_forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Видалення записів з таблиці % заборонено (юридична вимога)', TG_TABLE_NAME
    USING ERRCODE = 'P0403';
END $$;

-- Підключення тригерів у циклі
DO $$
DECLARE
  t text;
  v_audit text[] := ARRAY[
    'users', 'departments', 'doctors', 'doctor_schedules', 'patients', 'insurance_companies', 'patient_insurances',
    'appointments', 'wards', 'beds', 'admissions', 'medical_records', 'diagnoses', 'medications', 'prescriptions',
    'lab_orders', 'lab_results', 'invoices', 'invoice_items', 'payments'];
  v_soft text[] := ARRAY[
    'users', 'patients', 'doctors', 'departments', 'wards', 'beds', 'medications', 'insurance_companies'];
  v_forbid text[] := ARRAY['medical_records', 'diagnoses', 'prescriptions', 'prescription_items', 'payments'];
BEGIN
  FOREACH t IN ARRAY v_audit LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION tf_set_audit_fields()',
                   'trg_' || t || '_audit_fields', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION tf_audit_log()',
                   'trg_' || t || '_audit_log', t);
  END LOOP;
  FOREACH t IN ARRAY v_soft LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION tf_soft_delete()',
                   'trg_' || t || '_soft_delete', t);
  END LOOP;
  FOREACH t IN ARRAY v_forbid LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION tf_forbid_delete()',
                   'trg_' || t || '_forbid_delete', t);
  END LOOP;
END $$;

-- Універсальний soft delete (білий список = SoftDeleteTable у contracts)
CREATE PROCEDURE sp_soft_delete(p_table text, p_id int)
LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  IF p_table IS NULL OR p_table <> ALL (ARRAY[
      'users', 'patients', 'doctors', 'departments', 'wards', 'beds', 'medications', 'insurance_companies']) THEN
    RAISE EXCEPTION 'Таблиця % не підтримує soft delete', p_table USING ERRCODE = '22023';
  END IF;
  IF p_table = 'users' AND p_id = fn_current_user_id() THEN
    RAISE EXCEPTION 'Не можна видалити власний обліковий запис' USING ERRCODE = 'P0409';
  END IF;
  IF p_table = 'beds' AND EXISTS (SELECT 1 FROM beds WHERE id = p_id AND status = 'occupied') THEN
    RAISE EXCEPTION 'Ліжко зайняте — спочатку випишіть або переведіть пацієнта' USING ERRCODE = 'P0409';
  END IF;
  EXECUTE format('UPDATE %I SET deleted_at = now(), deleted_by = fn_current_user_id() WHERE id = $1 AND deleted_at IS NULL',
                 p_table)
    USING p_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'Запис % #% не знайдено або вже видалено', p_table, p_id USING ERRCODE = 'P0002';
  END IF;
END $$;

-- Відновлення soft-видаленого запису; лише адміністратор
CREATE PROCEDURE sp_restore(p_table text, p_id int)
LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.id = fn_current_user_id() AND r.code = 'admin' AND u.deleted_at IS NULL AND u.is_active
  ) THEN
    RAISE EXCEPTION 'Відновлювати записи може лише адміністратор' USING ERRCODE = 'P0403';
  END IF;
  IF p_table IS NULL OR p_table <> ALL (ARRAY[
      'users', 'patients', 'doctors', 'departments', 'wards', 'beds', 'medications', 'insurance_companies']) THEN
    RAISE EXCEPTION 'Таблиця % не підтримує відновлення', p_table USING ERRCODE = '22023';
  END IF;
  EXECUTE format('UPDATE %I SET deleted_at = NULL, deleted_by = NULL WHERE id = $1 AND deleted_at IS NOT NULL', p_table)
    USING p_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'Видалений запис % #% не знайдено', p_table, p_id USING ERRCODE = 'P0002';
  END IF;
END $$;
