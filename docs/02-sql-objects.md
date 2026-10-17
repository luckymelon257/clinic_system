# План об'єктів бази даних

Префікси: `fn_` — функція, `sp_` — процедура, `trg_` — тригер (`tf_` — тригерна функція), `v_` — view, `mv_` — materialized view, `ix_/ux_` — індекс.

## 0. Розширення та типи
- `btree_gist` — для `EXCLUDE`-обмежень (перетин часу прийомів / госпіталізацій).
- `pg_trgm` — нечіткий пошук пацієнтів.
- `pgcrypto` — `crypt()`/`gen_salt()` для seed-паролів *(опційно, у коді — bcrypt)*.
- 14 ENUM-типів, домен `d_phone` (`CHECK` формату), `d_money` (`numeric(12,2) CHECK >= 0`).
- Послідовність `invoice_number_seq` для номерів рахунків.

## 1. Механізм аудиту та soft delete (сутності з п.3)

Поточний користувач передається з коду: Unit of Work на початку транзакції виконує
`SELECT set_config('app.current_user_id', $1, true)` (діє до кінця транзакції).

| Об'єкт | Тип | Опис |
|---|---|---|
| `fn_current_user_id()` | функція | Читає `current_setting('app.current_user_id', true)::int` (NULL, якщо не задано) |
| `tf_set_audit_fields` → `trg_<table>_audit_fields` | тригер BEFORE INSERT/UPDATE | Заповнює `created_at/created_by` при вставці, `updated_at/updated_by` при оновленні; забороняє змінювати `created_*` |
| `tf_audit_log` → `trg_<table>_audit_log` | тригер AFTER INSERT/UPDATE/DELETE | Пише у `audit_log` старі/нові дані (`to_jsonb`), список змінених полів, тип операції (розпізнає `SOFT_DELETE`/`RESTORE` за зміною `deleted_at`) |
| `tf_soft_delete` → `trg_<table>_soft_delete` | тригер BEFORE DELETE | Замість фізичного видалення робить `UPDATE … SET deleted_at = now(), deleted_by = fn_current_user_id()` і повертає `NULL` |
| `tf_forbid_delete` → `trg_<table>_forbid_delete` | тригер BEFORE DELETE | `RAISE EXCEPTION` для `medical_records`, `diagnoses`, `prescriptions`, `payments` |
| `sp_soft_delete(p_table, p_id)` | процедура | Універсальний soft delete через динамічний SQL (`format('%I')`), з перевіркою, що таблиця з білого списку |
| `sp_restore(p_table, p_id)` | процедура | Відновлення: `deleted_at = NULL`; тільки для `admin` |

Тригер аудиту підключається у циклі `DO $$ … $$` до всіх таблиць зі списку, щоб не дублювати код.

## 2. Користувацькі функції

| Функція | Повертає | Призначення |
|---|---|---|
| `fn_patient_age(p_dob date)` | `int` | Вік у роках (`IMMUTABLE`), використовується у view |
| `fn_full_name(last, first, middle)` | `text` | Форматування ПІБ (`IMMUTABLE`) |
| `fn_is_doctor_available(p_doctor_id, p_start, p_end, p_exclude_appointment_id)` | `boolean` | Перевірка: у межах розкладу + немає перетинів |
| `fn_doctor_free_slots(p_doctor_id, p_date)` | `TABLE(slot_start, slot_end)` | Вільні слоти на дату (`generate_series` по розкладу мінус зайняті) |
| `fn_active_insurance(p_patient_id, p_on date)` | `patient_insurances` | Діючий поліс з максимальним покриттям |
| `fn_calc_stay_cost(p_admission_id)` | `numeric` | Кількість діб × `daily_rate` палати |
| `fn_patient_history(p_patient_id)` | `TABLE(event_at, event_type, description, doctor)` | Хронологія: прийоми, діагнози, аналізи, госпіталізації (`UNION ALL`) |
| `fn_search_patients(p_query text, p_limit int)` | `SETOF v_patients` | Нечіткий пошук за ПІБ (`similarity`, `%` оператор trgm) і телефоном |
| `fn_department_occupancy(p_department_id)` | `numeric` | % зайнятих ліжок |

## 3. Збережені процедури (усі операції запису з коду)

Процедури повертають id створеного запису через `INOUT`-параметр. Помилки бізнес-правил —
`RAISE EXCEPTION … USING ERRCODE = 'P0001'..'P0099'`, щоб API мапило їх у HTTP 409/422.

**Пацієнти**
- `sp_patient_create(…, INOUT p_id)` — валідація, створення.
- `sp_patient_update(p_id, …)` — оновлення (audit-поля проставить тригер), помилка якщо пацієнт видалений.
- `sp_patient_insurance_add(p_patient_id, p_company_id, p_policy, p_coverage, p_from, p_to, INOUT p_id)`.

**Прийоми**
- `sp_appointment_book(p_patient_id, p_doctor_id, p_start, p_reason, INOUT p_id)` — тривалість = `slot_minutes` з розкладу; перевірка `fn_is_doctor_available`; соф-видалені пацієнт/лікар заборонені.
- `sp_appointment_reschedule(p_id, p_new_start)`.
- `sp_appointment_set_status(p_id, p_status)` — контроль допустимих переходів статусів.
- `sp_appointment_cancel(p_id, p_reason)`.

**Медичні записи**
- `sp_medical_record_create(p_appointment_id | p_admission_id, p_complaints, p_examination, p_conclusion, p_recommendations, INOUT p_id)` — для прийому переводить його в `completed`.
- `sp_diagnosis_add(p_record_id, p_icd10_code, p_kind, p_notes, INOUT p_id)`.
- `sp_prescription_create(p_record_id, p_valid_until, p_items jsonb, INOUT p_id)` — позиції з JSON-масиву (`jsonb_to_recordset`).

**Лабораторія**
- `sp_lab_order_create(p_patient_id, p_doctor_id, p_record_id, p_priority, p_test_codes text[], INOUT p_id)`.
- `sp_lab_result_record(p_order_id, p_test_type_id, p_value_numeric, p_value_text)` — після останнього результату замовлення стає `completed`.

**Стаціонар**
- `sp_admit_patient(p_patient_id, p_bed_id, p_doctor_id, p_reason, INOUT p_id)` — перевіряє, що ліжко `available`.
- `sp_transfer_patient(p_admission_id, p_new_bed_id)`.
- `sp_discharge_patient(p_admission_id, p_summary, INOUT p_invoice_id)` — виписка + виклик `sp_invoice_generate_for_admission`.

**Фінанси**
- `sp_invoice_create(p_patient_id, p_appointment_id, p_admission_id, INOUT p_id)` — номер з послідовності, підставляє діючий поліс.
- `sp_invoice_add_item(p_invoice_id, p_type, p_description, p_qty, p_unit_price, INOUT p_id)`.
- `sp_invoice_generate_for_admission(p_admission_id, INOUT p_invoice_id)` — проживання + аналізи + консультації.
- `sp_invoice_issue(p_invoice_id, p_due_days)` — `draft → issued`.
- `sp_payment_register(p_invoice_id, p_amount, p_method, p_ref, INOUT p_id)` — BR-7.
- `sp_refresh_reports()` — `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_revenue`.

## 4. Бізнес-тригери

| Тригер | Таблиця / подія | Дія |
|---|---|---|
| `trg_admissions_bed_status` | `admissions` AFTER INSERT/UPDATE | Госпіталізація → ліжко `occupied`; виписка/переведення → `available` |
| `trg_invoice_items_recalc` | `invoice_items` AFTER INSERT/UPDATE/DELETE | Перерахунок `subtotal`, `insurance_amount`, `total_due` рахунку |
| `trg_payments_invoice_status` | `payments` AFTER INSERT | Оновлює `paid_amount`, статус `partially_paid` / `paid` |
| `trg_lab_results_abnormal` | `lab_results` BEFORE INSERT/UPDATE | Обчислює `is_abnormal` за `ref_min/ref_max` |
| `trg_appointments_status_guard` | `appointments` BEFORE UPDATE | Забороняє зміни завершених/скасованих прийомів |

## 5. Розрізи даних (View)

| View | Опис |
|---|---|
| `v_patients` | Активні пацієнти (`deleted_at IS NULL`) + вік, ПІБ, діючий поліс |
| `v_doctors` | Активні лікарі + відділення, спеціалізація, email |
| `v_doctor_schedule` | Розклад лікарів з назвами днів |
| `v_appointments` | Прийоми з іменами пацієнта/лікаря, відділенням, статусом |
| `v_today_appointments` | Прийоми на сьогодні (по `current_date`) |
| `v_medical_records` | Медичні записи + агрегований список діагнозів (`string_agg`) |
| `v_prescriptions` | Рецепти з позиціями (`jsonb_agg`) |
| `v_lab_queue` | Незавершені аналізи, сортування за пріоритетом/часом |
| `v_lab_results` | Результати з одиницями, нормами, позначкою відхилення |
| `v_current_admissions` | Пацієнти у стаціонарі зараз: палата, ліжко, лікар, кількість діб |
| `v_bed_occupancy` | Заповненість по відділеннях/палатах (всього / зайнято / %) |
| `v_invoices` | Рахунки з залишком до сплати і ознакою прострочення |
| `v_unpaid_invoices` | `issued`/`partially_paid` з боргом > 0 |
| `v_audit_log` | Журнал аудиту з email автора зміни |
| `v_deleted_records` | `UNION ALL` soft-видалених записів з усіх таблиць (для адмін-відновлення) |
| `mv_monthly_revenue` | **Materialized view**: виручка по місяцях × відділеннях × способах оплати |

## 6. Індекси

| Тип | Приклад | Навіщо |
|---|---|---|
| **B-tree** | `ix_appointments_doctor_start (doctor_id, starts_at)` | Розклад лікаря, діапазонні запити |
| **Unique** | `(ward_id, bed_number)`, `icd10_code` | Цілісність |
| **Partial unique** | `ux_users_email_active ON users (lower(email)) WHERE deleted_at IS NULL` | Email можна перевикористати після soft delete |
| **Partial** | `ix_beds_available ON beds (ward_id) WHERE status = 'available'` | Швидкий пошук вільних ліжок |
| **Expression** | `lower(email)` | Пошук без урахування регістру |
| **GIN (trgm)** | `ix_patients_fullname_trgm ON patients USING gin ((last_name || ' ' || first_name) gin_trgm_ops)` | `ILIKE '%…%'` та `similarity` |
| **GIN (jsonb)** | `ix_audit_new_data ON audit_log USING gin (new_data jsonb_path_ops)` | Пошук у журналі за значенням поля |
| **GiST** | `EXCLUDE USING gist` на `appointments`, `admissions` | Заборона перетину інтервалів |
| **BRIN** | `ix_audit_changed_at ON audit_log USING brin (changed_at)`, `payments(paid_at)` | Великі хронологічні таблиці, мінімальний розмір індексу |
| **Covering** | `ix_appointments_patient ON appointments (patient_id) INCLUDE (starts_at, status)` | Index-only scan для історії пацієнта |

У звіті до лаби — `EXPLAIN ANALYZE` до/після створення індексів на seed-даних (~10k пацієнтів, ~100k прийомів через `generate_series`).

## 7. Підсумок

| Категорія | Кількість |
|---|---|
| Функції | 10 |
| Процедури | 24 |
| Тригерні функції / тригери | 9 / ~40 (аудит підключено до 14 таблиць) |
| View + materialized view | 15 + 1 |
| Типи індексів | 7 (B-tree, unique, partial, expression, GIN, GiST, BRIN) + covering |
