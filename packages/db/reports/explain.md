# EXPLAIN (ANALYZE, BUFFERS): до / після індексів

Згенеровано скриптом `pnpm --filter @clinic/db explain` 2026-10-17T10:10:28.240Z на базі `clinic_db_dev`
(`reset` з volume-даними, після `VACUUM ANALYZE`). Вивід — реальний, без редагування.

Обсяг: patients = 10040, payments = 28938, invoices = 31026, appointments = 106419, audit_log = 277638.

| Тип індексу | Індекс | До, ms | Після, ms | Прискорення |
|---|---|---:|---:|---:|
| B-tree (composite) | `ix_appointments_doctor_start` | 4.523 | 0.044 | 102.8× |
| Unique | `ux_invoices_number` | 3.813 | 0.014 | 272.4× |
| Partial | `ix_invoices_unpaid` | 3.182 | 1.253 | 2.5× |
| Expression | `ix_patients_email_lower` | 1.672 | 0.008 | 209.0× |
| GIN (pg_trgm) | `ix_patients_fullname_trgm` | 3.533 | 0.123 | 28.7× |
| GIN (jsonb_path_ops) | `ix_audit_new_data` | 31.938 | 0.032 | 998.1× |
| GiST (EXCLUDE) | `ex_appointments_doctor_overlap` | 8.367 | 0.041 | 204.1× |
| BRIN | `ix_payments_paid_at` | 2.090 | 0.407 | 5.1× |
| Covering (INCLUDE) | `ix_appointments_patient` | 2.651 | 0.018 | 147.3× |

## B-tree (composite)

**Індекс:** `ix_appointments_doctor_start ON appointments (doctor_id, starts_at)`
Розклад лікаря за період (діапазонний запит по другому стовпцю).

```sql
SELECT id, starts_at, status FROM appointments
WHERE doctor_id = 4 AND starts_at >= current_date - 60 AND starts_at < current_date - 53
ORDER BY starts_at;
```

**До** (у транзакції: `DROP INDEX ix_appointments_doctor_start; DROP INDEX ix_appointments_starts_at` → EXPLAIN → ROLLBACK):

```
Gather Merge  (cost=4182.76..4188.05 rows=46 width=16) (actual time=3.619..4.515 rows=79 loops=1)
  Workers Planned: 1
  Workers Launched: 1
  Buffers: shared hit=1499
  ->  Sort  (cost=3182.75..3182.87 rows=46 width=16) (actual time=2.693..2.694 rows=40 loops=2)
        Sort Key: starts_at
        Sort Method: quicksort  Memory: 27kB
        Buffers: shared hit=1499
        Worker 0:  Sort Method: quicksort  Memory: 26kB
        ->  Parallel Seq Scan on appointments  (cost=0.00..3181.48 rows=46 width=16) (actual time=0.904..2.671 rows=40 loops=2)
              Filter: ((doctor_id = 4) AND (starts_at >= (CURRENT_DATE - 60)) AND (starts_at < (CURRENT_DATE - 53)))
              Rows Removed by Filter: 53170
              Buffers: shared hit=1460
Planning:
  Buffers: shared hit=7
Planning Time: 0.063 ms
Execution Time: 4.523 ms
```

**Після** (з індексом):

```
Sort  (cost=265.05..265.25 rows=79 width=16) (actual time=0.035..0.036 rows=79 loops=1)
  Sort Key: starts_at
  Sort Method: quicksort  Memory: 28kB
  Buffers: shared hit=18
  ->  Bitmap Heap Scan on appointments  (cost=5.43..262.56 rows=79 width=16) (actual time=0.016..0.029 rows=79 loops=1)
        Recheck Cond: ((doctor_id = 4) AND (starts_at >= (CURRENT_DATE - 60)) AND (starts_at < (CURRENT_DATE - 53)))
        Heap Blocks: exact=15
        Buffers: shared hit=18
        ->  Bitmap Index Scan on ix_appointments_doctor_start  (cost=0.00..5.42 rows=79 width=0) (actual time=0.013..0.013 rows=79 loops=1)
              Index Cond: ((doctor_id = 4) AND (starts_at >= (CURRENT_DATE - 60)) AND (starts_at < (CURRENT_DATE - 53)))
              Buffers: shared hit=3
Planning:
  Buffers: shared hit=36
Planning Time: 0.097 ms
Execution Time: 0.044 ms
```

## Unique

**Індекс:** `ux_invoices_number ON invoices (number) — UNIQUE constraint`
Пошук рахунку за номером; цілісність номерів.

```sql
SELECT id, status, total_due FROM invoices WHERE number = 'INV-2025-015001';
```

**До** (у транзакції: `ALTER TABLE invoices DROP CONSTRAINT ux_invoices_number` → EXPLAIN → ROLLBACK):

```
Seq Scan on invoices  (cost=0.00..1842.83 rows=1 width=12) (actual time=2.673..3.808 rows=1 loops=1)
  Filter: (number = 'INV-2025-015001'::text)
  Rows Removed by Filter: 31025
  Buffers: shared hit=1200 read=255 written=205
Planning:
  Buffers: shared hit=6
Planning Time: 0.021 ms
Execution Time: 3.813 ms
```

**Після** (з індексом):

```
Index Scan using ux_invoices_number on invoices  (cost=0.29..8.30 rows=1 width=12) (actual time=0.008..0.008 rows=1 loops=1)
  Index Cond: (number = 'INV-2025-015001'::text)
  Buffers: shared hit=3
Planning:
  Buffers: shared hit=19
Planning Time: 0.095 ms
Execution Time: 0.014 ms
```

## Partial

**Індекс:** `ix_invoices_unpaid ON invoices (due_date) WHERE status IN ('issued', 'partially_paid')`
Прострочені рахунки: індексуються лише неоплачені рядки (малий індекс).

```sql
SELECT id, number, due_date FROM invoices
WHERE status IN ('issued', 'partially_paid') AND due_date < current_date
ORDER BY due_date;
```

**До** (у транзакції: `DROP INDEX ix_invoices_unpaid` → EXPLAIN → ROLLBACK):

```
Sort  (cost=2170.18..2177.64 rows=2984 width=24) (actual time=3.076..3.133 rows=2943 loops=1)
  Sort Key: due_date
  Sort Method: quicksort  Memory: 234kB
  Buffers: shared hit=1455
  ->  Seq Scan on invoices  (cost=0.00..1997.95 rows=2984 width=24) (actual time=0.005..2.886 rows=2943 loops=1)
        Filter: ((status = ANY ('{issued,partially_paid}'::invoice_status[])) AND (due_date < CURRENT_DATE))
        Rows Removed by Filter: 28083
        Buffers: shared hit=1455
Planning:
  Buffers: shared hit=6
Planning Time: 0.048 ms
Execution Time: 3.182 ms
```

**Після** (з індексом):

```
Sort  (cost=1954.85..1962.31 rows=2984 width=24) (actual time=1.136..1.185 rows=2943 loops=1)
  Sort Key: due_date
  Sort Method: quicksort  Memory: 234kB
  Buffers: shared hit=1010
  ->  Bitmap Heap Scan on invoices  (cost=275.41..1782.63 rows=2984 width=24) (actual time=0.189..0.965 rows=2943 loops=1)
        Recheck Cond: ((due_date < CURRENT_DATE) AND (status = ANY ('{issued,partially_paid}'::invoice_status[])))
        Heap Blocks: exact=948
        Buffers: shared hit=1010
        ->  Bitmap Index Scan on ix_invoices_unpaid  (cost=0.00..274.66 rows=2984 width=0) (actual time=0.132..0.132 rows=2943 loops=1)
              Index Cond: (due_date < CURRENT_DATE)
              Buffers: shared hit=62
Planning:
  Buffers: shared hit=19
Planning Time: 0.076 ms
Execution Time: 1.253 ms
```

## Expression

**Індекс:** `ix_patients_email_lower ON patients (lower(email))`
Пошук пацієнта за email без урахування регістру.

```sql
SELECT id, last_name, first_name FROM patients WHERE lower(email) = lower('P8170@MAIL.EXAMPLE');
```

**До** (у транзакції: `DROP INDEX ix_patients_email_lower` → EXPLAIN → ROLLBACK):

```
Seq Scan on patients  (cost=0.00..367.60 rows=50 width=32) (actual time=1.145..1.668 rows=1 loops=1)
  Filter: (lower(email) = 'p8170@mail.example'::text)
  Rows Removed by Filter: 10039
  Buffers: shared hit=177 read=40 written=34
Planning:
  Buffers: shared hit=6
Planning Time: 0.039 ms
Execution Time: 1.672 ms
```

**Після** (з індексом):

```
Index Scan using ix_patients_email_lower on patients  (cost=0.29..8.30 rows=1 width=32) (actual time=0.005..0.005 rows=1 loops=1)
  Index Cond: (lower(email) = 'p8170@mail.example'::text)
  Buffers: shared hit=3
Planning:
  Buffers: shared hit=22
Planning Time: 0.062 ms
Execution Time: 0.008 ms
```

## GIN (pg_trgm)

**Індекс:** `ix_patients_fullname_trgm ON patients USING gin ((last_name || ' ' || first_name) gin_trgm_ops)`
Нечіткий пошук ILIKE '%…%' (fn_search_patients).

```sql
SELECT id, last_name, first_name FROM patients
WHERE (last_name || ' ' || first_name) ILIKE '%ченко Окс%';
```

**До** (у транзакції: `DROP INDEX ix_patients_fullname_trgm` → EXPLAIN → ROLLBACK):

```
Seq Scan on patients  (cost=0.00..392.70 rows=1 width=32) (actual time=0.058..3.530 rows=54 loops=1)
  Filter: (((last_name || ' '::text) || first_name) ~~* '%ченко Окс%'::text)
  Rows Removed by Filter: 9986
  Buffers: shared hit=217
Planning:
  Buffers: shared hit=6
Planning Time: 0.017 ms
Execution Time: 3.533 ms
```

**Після** (з індексом):

```
Bitmap Heap Scan on patients  (cost=65.30..233.22 rows=89 width=32) (actual time=0.087..0.116 rows=54 loops=1)
  Recheck Cond: (((last_name || ' '::text) || first_name) ~~* '%ченко Окс%'::text)
  Heap Blocks: exact=44
  Buffers: shared hit=62
  ->  Bitmap Index Scan on ix_patients_fullname_trgm  (cost=0.00..65.28 rows=89 width=0) (actual time=0.081..0.081 rows=54 loops=1)
        Index Cond: (((last_name || ' '::text) || first_name) ~~* '%ченко Окс%'::text)
        Buffers: shared hit=18
Planning:
  Buffers: shared hit=24
Planning Time: 0.133 ms
Execution Time: 0.123 ms
```

## GIN (jsonb_path_ops)

**Індекс:** `ix_audit_new_data ON audit_log USING gin (new_data jsonb_path_ops)`
Пошук у журналі аудиту за значенням поля (оператор @>).

```sql
SELECT id, table_name, record_id, operation, changed_at FROM audit_log
WHERE new_data @> '{"patient_id": 4362}';
```

**До** (у транзакції: `DROP INDEX ix_audit_new_data` → EXPLAIN → ROLLBACK):

```
Gather  (cost=1000.00..23589.83 rows=28 width=31) (actual time=6.145..31.929 rows=14 loops=1)
  Workers Planned: 2
  Workers Launched: 2
  Buffers: shared hit=7910 read=13231 written=85
  ->  Parallel Seq Scan on audit_log  (cost=0.00..22587.03 rows=12 width=31) (actual time=4.279..29.105 rows=5 loops=3)
        Filter: (new_data @> '{"patient_id": 4362}'::jsonb)
        Rows Removed by Filter: 92541
        Buffers: shared hit=7910 read=13231 written=85
Planning:
  Buffers: shared hit=7
Planning Time: 0.051 ms
Execution Time: 31.938 ms
```

**Після** (з індексом):

```
Bitmap Heap Scan on audit_log  (cost=17.24..126.54 rows=28 width=31) (actual time=0.013..0.024 rows=14 loops=1)
  Recheck Cond: (new_data @> '{"patient_id": 4362}'::jsonb)
  Heap Blocks: exact=14
  Buffers: shared hit=18
  ->  Bitmap Index Scan on ix_audit_new_data  (cost=0.00..17.24 rows=28 width=0) (actual time=0.008..0.008 rows=14 loops=1)
        Index Cond: (new_data @> '{"patient_id": 4362}'::jsonb)
        Buffers: shared hit=4
Planning:
  Buffers: shared hit=20
Planning Time: 0.097 ms
Execution Time: 0.032 ms
```

## GiST (EXCLUDE)

**Індекс:** `ex_appointments_doctor_overlap EXCLUDE USING gist (doctor_id WITH =, tstzrange(starts_at, ends_at) WITH &&)`
BR-1: перевірка перетину інтервалів (так само шукає fn_is_doctor_available).

```sql
SELECT id, starts_at, ends_at FROM appointments
WHERE doctor_id = 4 AND status NOT IN ('cancelled', 'no_show')
  AND tstzrange(starts_at, ends_at) && tstzrange((current_date - 100) + time '10:00', (current_date - 100) + time '12:00');
```

**До** (у транзакції: `ALTER TABLE appointments DROP CONSTRAINT ex_appointments_doctor_overlap` → EXPLAIN → ROLLBACK):

```
Bitmap Heap Scan on appointments  (cost=232.61..2033.63 rows=65 width=20) (actual time=8.069..8.359 rows=3 loops=1)
  Recheck Cond: (doctor_id = 4)
  Filter: ((status <> ALL ('{cancelled,no_show}'::appointment_status[])) AND (tstzrange(starts_at, ends_at) && tstzrange((((CURRENT_DATE - 100) + '10:00:00'::time without time zone))::timestamp with time zone, (((CURRENT_DATE - 100) + '12:00:00'::time without time zone))::timestamp with time zone)))
  Rows Removed by Filter: 8076
  Heap Blocks: exact=1460
  Buffers: shared hit=1463 read=42
  ->  Bitmap Index Scan on ix_appointments_doctor_start  (cost=0.00..232.60 rows=8024 width=0) (actual time=5.976..5.976 rows=8079 loops=1)
        Index Cond: (doctor_id = 4)
        Buffers: shared hit=3 read=42
Planning:
  Buffers: shared hit=7
Planning Time: 0.049 ms
Execution Time: 8.367 ms
```

**Після** (з індексом):

```
Bitmap Heap Scan on appointments  (cost=4.97..223.53 rows=65 width=20) (actual time=0.029..0.030 rows=3 loops=1)
  Recheck Cond: ((doctor_id = 4) AND (tstzrange(starts_at, ends_at) && tstzrange((((CURRENT_DATE - 100) + '10:00:00'::time without time zone))::timestamp with time zone, (((CURRENT_DATE - 100) + '12:00:00'::time without time zone))::timestamp with time zone)) AND (status <> ALL ('{cancelled,no_show}'::appointment_status[])))
  Heap Blocks: exact=2
  Buffers: shared hit=7
  ->  Bitmap Index Scan on ex_appointments_doctor_overlap  (cost=0.00..4.95 rows=65 width=0) (actual time=0.027..0.027 rows=3 loops=1)
        Index Cond: ((doctor_id = 4) AND (tstzrange(starts_at, ends_at) && tstzrange((((CURRENT_DATE - 100) + '10:00:00'::time without time zone))::timestamp with time zone, (((CURRENT_DATE - 100) + '12:00:00'::time without time zone))::timestamp with time zone)))
        Buffers: shared hit=5
Planning:
  Buffers: shared hit=22
Planning Time: 0.101 ms
Execution Time: 0.041 ms
```

## BRIN

**Індекс:** `ix_payments_paid_at ON payments USING brin (paid_at)`
Хронологічна таблиця оплат: діапазон дат, індекс займає кілька сторінок.

```sql
SELECT count(*), sum(amount) FROM payments
WHERE paid_at >= current_date - 400 AND paid_at < current_date - 370;
```

**До** (у транзакції: `DROP INDEX ix_payments_paid_at` → EXPLAIN → ROLLBACK):

```
Aggregate  (cost=1029.33..1029.34 rows=1 width=40) (actual time=2.085..2.085 rows=1 loops=1)
  Buffers: shared hit=300
  ->  Seq Scan on payments  (cost=0.00..1023.45 rows=1175 width=5) (actual time=0.008..2.044 rows=1192 loops=1)
        Filter: ((paid_at >= (CURRENT_DATE - 400)) AND (paid_at < (CURRENT_DATE - 370)))
        Rows Removed by Filter: 27746
        Buffers: shared hit=300
Planning:
  Buffers: shared hit=7
Planning Time: 0.036 ms
Execution Time: 2.090 ms
```

**Після** (з індексом):

```
Aggregate  (cost=361.74..361.75 rows=1 width=40) (actual time=0.401..0.401 rows=1 loops=1)
  Buffers: shared hit=46
  ->  Bitmap Heap Scan on payments  (cost=12.31..355.86 rows=1175 width=5) (actual time=0.014..0.362 rows=1192 loops=1)
        Recheck Cond: ((paid_at >= (CURRENT_DATE - 400)) AND (paid_at < (CURRENT_DATE - 370)))
        Rows Removed by Index Recheck: 2914
        Heap Blocks: lossy=44
        Buffers: shared hit=46
        ->  Bitmap Index Scan on ix_payments_paid_at  (cost=0.00..12.01 rows=1742 width=0) (actual time=0.006..0.006 rows=440 loops=1)
              Index Cond: ((paid_at >= (CURRENT_DATE - 400)) AND (paid_at < (CURRENT_DATE - 370)))
              Buffers: shared hit=2
Planning:
  Buffers: shared hit=20
Planning Time: 0.044 ms
Execution Time: 0.407 ms
```

## Covering (INCLUDE)

**Індекс:** `ix_appointments_patient ON appointments (patient_id) INCLUDE (starts_at, status)`
Історія прийомів пацієнта: Index Only Scan без звернення до таблиці.

```sql
SELECT starts_at, status FROM appointments WHERE patient_id = 9 ORDER BY starts_at;
```

**До** (у транзакції: `DROP INDEX ix_appointments_patient` → EXPLAIN → ROLLBACK):

```
Sort  (cost=2793.52..2793.77 rows=99 width=12) (actual time=2.646..2.648 rows=62 loops=1)
  Sort Key: starts_at
  Sort Method: quicksort  Memory: 27kB
  Buffers: shared hit=1460
  ->  Seq Scan on appointments  (cost=0.00..2790.24 rows=99 width=12) (actual time=0.003..2.642 rows=62 loops=1)
        Filter: (patient_id = 9)
        Rows Removed by Filter: 106357
        Buffers: shared hit=1460
Planning:
  Buffers: shared hit=7
Planning Time: 0.024 ms
Execution Time: 2.651 ms
```

**Після** (з індексом):

```
Sort  (cost=9.43..9.68 rows=99 width=12) (actual time=0.013..0.014 rows=62 loops=1)
  Sort Key: starts_at
  Sort Method: quicksort  Memory: 27kB
  Buffers: shared hit=4
  ->  Index Only Scan using ix_appointments_patient on appointments  (cost=0.42..6.15 rows=99 width=12) (actual time=0.006..0.008 rows=62 loops=1)
        Index Cond: (patient_id = 9)
        Heap Fetches: 0
        Buffers: shared hit=4
Planning:
  Buffers: shared hit=26
Planning Time: 0.033 ms
Execution Time: 0.018 ms
```
