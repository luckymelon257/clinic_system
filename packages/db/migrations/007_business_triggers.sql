-- 007: бізнес-тригери (docs/02-sql-objects.md §4)

-- Госпіталізація → ліжко occupied; виписка / переведення → попереднє ліжко available
CREATE FUNCTION tf_admissions_bed_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'active'
     AND (NEW.status <> 'active' OR NEW.bed_id <> OLD.bed_id) THEN
    UPDATE beds SET status = 'available' WHERE id = OLD.bed_id AND status = 'occupied';
  END IF;
  IF NEW.status = 'active'
     AND (TG_OP = 'INSERT' OR OLD.status <> 'active' OR NEW.bed_id <> OLD.bed_id) THEN
    UPDATE beds SET status = 'occupied' WHERE id = NEW.bed_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_admissions_bed_status
AFTER INSERT OR UPDATE OF status, bed_id ON admissions
FOR EACH ROW EXECUTE FUNCTION tf_admissions_bed_status();

-- Перерахунок subtotal / insurance_amount / total_due рахунку за його позиціями
CREATE FUNCTION tf_invoice_items_recalc() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ids int[];
BEGIN
  v_ids := CASE TG_OP
    WHEN 'INSERT' THEN ARRAY[NEW.invoice_id]
    WHEN 'DELETE' THEN ARRAY[OLD.invoice_id]
    ELSE ARRAY[OLD.invoice_id, NEW.invoice_id]
  END;
  UPDATE invoices i
  SET subtotal = s.subtotal,
      insurance_amount = round(s.subtotal * i.insurance_coverage_percent / 100, 2),
      total_due = s.subtotal - round(s.subtotal * i.insurance_coverage_percent / 100, 2)
  FROM (
    SELECT inv.id, coalesce(sum(it.amount), 0) AS subtotal
    FROM invoices inv
    LEFT JOIN invoice_items it ON it.invoice_id = inv.id
    WHERE inv.id = ANY (v_ids)
    GROUP BY inv.id
  ) s
  WHERE i.id = s.id;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_invoice_items_recalc
AFTER INSERT OR UPDATE OR DELETE ON invoice_items
FOR EACH ROW EXECUTE FUNCTION tf_invoice_items_recalc();

-- Оплата → paid_amount і статус partially_paid / paid
CREATE FUNCTION tf_payments_invoice_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE invoices i
  SET paid_amount = s.paid,
      status = CASE WHEN s.paid >= i.total_due THEN 'paid'::invoice_status ELSE 'partially_paid'::invoice_status END
  FROM (SELECT coalesce(sum(amount), 0) AS paid FROM payments WHERE invoice_id = NEW.invoice_id) s
  WHERE i.id = NEW.invoice_id;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_payments_invoice_status
AFTER INSERT ON payments
FOR EACH ROW EXECUTE FUNCTION tf_payments_invoice_status();

-- is_abnormal за ref_min / ref_max тесту (NULL, якщо немає числового значення або референтного діапазону)
CREATE FUNCTION tf_lab_results_abnormal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_min numeric;
  v_max numeric;
BEGIN
  SELECT ref_min, ref_max INTO v_min, v_max FROM lab_test_types WHERE id = NEW.test_type_id;
  NEW.is_abnormal := CASE
    WHEN NEW.value_numeric IS NULL OR (v_min IS NULL AND v_max IS NULL) THEN NULL
    ELSE coalesce(NEW.value_numeric < v_min, false) OR coalesce(NEW.value_numeric > v_max, false)
  END;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_lab_results_abnormal
BEFORE INSERT OR UPDATE ON lab_results
FOR EACH ROW EXECUTE FUNCTION tf_lab_results_abnormal();

-- Завершені / скасовані / неявки змінювати заборонено; переходи статусів:
--   scheduled → confirmed | in_progress | completed | cancelled | no_show
--   confirmed → in_progress | completed | cancelled | no_show
--   in_progress → completed
-- (completed зі scheduled / confirmed дозволено, бо sp_medical_record_create завершує прийом одразу)
CREATE FUNCTION tf_appointments_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('completed', 'cancelled', 'no_show') THEN
    RAISE EXCEPTION 'Прийом у статусі % змінювати заборонено', OLD.status USING ERRCODE = 'P0031';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'scheduled' AND NEW.status IN ('confirmed', 'in_progress', 'completed', 'cancelled', 'no_show'))
    OR (OLD.status = 'confirmed' AND NEW.status IN ('in_progress', 'completed', 'cancelled', 'no_show'))
    OR (OLD.status = 'in_progress' AND NEW.status = 'completed')
  ) THEN
    RAISE EXCEPTION 'Недопустимий перехід статусу прийому: % → %', OLD.status, NEW.status USING ERRCODE = 'P0031';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_appointments_status_guard
BEFORE UPDATE ON appointments
FOR EACH ROW EXECUTE FUNCTION tf_appointments_status_guard();
