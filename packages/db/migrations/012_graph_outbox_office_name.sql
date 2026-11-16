-- 012: подія outbox `office` несе ім'я лікаря (як v_graph_places), щоб вузол :Office, створений воркером,
-- мав ту саму назву, що й після повного ETL (усуває розбіжність D-49). Решта функції без змін (009).

CREATE OR REPLACE FUNCTION tf_graph_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r      record := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  v_op   text := CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END;
  v_ent  text;
  v_key  text;
  v_body jsonb;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'patients' THEN
      v_ent := 'patient'; v_key := r.id::text;
      v_body := jsonb_build_object('id', r.id, 'name', fn_full_name(r.last_name, r.first_name, r.middle_name));
    WHEN 'staff' THEN
      v_ent := 'staff'; v_key := r.id::text;
      v_body := jsonb_build_object('id', r.id, 'name', r.full_name, 'role', r.role);
    WHEN 'wards' THEN
      v_ent := 'ward'; v_key := r.id::text;
      v_body := jsonb_build_object('id', r.id, 'name', r.ward_number, 'departmentId', r.department_id, 'type', r.ward_type);
    WHEN 'rooms' THEN
      v_ent := 'room'; v_key := r.id::text;
      v_body := jsonb_build_object('id', r.id, 'name', r.room_number, 'wardId', r.ward_id);
    WHEN 'doctors' THEN
      v_ent := 'office'; v_key := r.id::text;
      v_body := jsonb_build_object('id', r.id, 'departmentId', r.department_id,
        'name', (SELECT u.full_name FROM users u WHERE u.id = r.user_id));
    WHEN 'admissions' THEN
      v_ent := 'presence'; v_key := 'admission:' || r.id; v_op := 'upsert';
      v_body := fn_graph_presence_payload('admission', r.id);
    WHEN 'staff_shifts' THEN
      v_ent := 'presence'; v_key := 'shift:' || r.id; v_op := 'upsert';
      v_body := fn_graph_presence_payload('shift', r.id);
    WHEN 'appointments' THEN
      v_ent := 'presence'; v_key := 'appointment:' || r.id; v_op := 'upsert';
      v_body := fn_graph_presence_payload('appointment', r.id);
    WHEN 'prescription_items' THEN
      v_ent := 'takes'; v_key := r.id::text;
      SELECT jsonb_build_object('rxItemId', t.rx_item_id, 'patientId', t.patient_id, 'medicationId', t.medication_id,
                                'f', fn_epoch_ms(t.f), 't', fn_epoch_ms(t.t))
        INTO v_body FROM v_takes t WHERE t.rx_item_id = r.id;
      v_body := coalesce(v_body, jsonb_build_object('rxItemId', r.id));
    WHEN 'medications' THEN
      v_ent := 'medication'; v_key := r.id::text;
      v_body := jsonb_build_object('id', r.id, 'name', r.name);
    WHEN 'drug_classes' THEN
      v_ent := 'drug_class'; v_key := r.id::text;
      v_body := jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name);
    WHEN 'medication_classes' THEN
      -- повний набір класів препарату (заміна цілком)
      v_ent := 'medication_class'; v_key := r.medication_id::text; v_op := 'upsert';
      v_body := jsonb_build_object('medicationId', r.medication_id, 'classIds',
        coalesce((SELECT jsonb_agg(mc.class_id ORDER BY mc.class_id) FROM medication_classes mc
                  WHERE mc.medication_id = r.medication_id), '[]'::jsonb));
    WHEN 'medication_interactions' THEN
      v_ent := 'medication_interaction'; v_key := r.medication_a || ':' || r.medication_b;
      v_body := jsonb_build_object('a', r.medication_a, 'b', r.medication_b, 'severity', r.severity);
    WHEN 'drug_class_interactions' THEN
      v_ent := 'class_interaction'; v_key := r.class_a || ':' || r.class_b;
      v_body := jsonb_build_object('a', r.class_a, 'b', r.class_b, 'severity', r.severity);
    ELSE
      RAISE EXCEPTION 'tf_graph_outbox: таблиця % не підтримується', TG_TABLE_NAME;
  END CASE;
  INSERT INTO graph_outbox (entity, entity_key, op, payload) VALUES (v_ent, v_key, v_op, v_body);
  RETURN NULL;
END $$;
