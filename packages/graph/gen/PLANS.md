# Plans the PostgreSQL graph functions rely on (×1, d3, patient 8100, window 2026-05-01 … 05-15)

Captured with `auto_explain` (`log_analyze`, `log_buffers`, `log_nested_statements`) on `clinic_bench_x1`
(PG 16, shared_buffers 1 GB, work_mem 32 MB, jit off). Result: 2 625 persons within 3 hops for both functions.

| Function | Total | Where the time goes |
|---|---:|---|
| `fn_trace_contacts` (BFS) | **418 ms** | level 1: 3 ms (index steps); window materialisation 95 ms (16 275 presences); level 2: 53 ms; level 3: 210 ms |
| `fn_trace_contacts_cte` (CTE + CYCLE) | **36 780 ms** | recursive union produced 8 597 206 rows (paths) for 2 625 distinct persons; 468 637 temp blocks written |

## BFS, small frontier (≤ 32): index steps per source

```
Index Scan using ix_admissions_patient_period on admissions a
  Index Cond: ((patient_id = 8100) AND (tstzrange(admitted_at, discharged_at) && '[2026-05-01, 2026-05-15)'))
Index Scan using ix_appointments_patient_period on appointments ap
  Index Cond: ((patient_id = 8100) AND (tstzrange(starts_at, ends_at) && …))
```
Then `fn_place_presence` for each place found: GiST `ix_admissions_bed_period (bed_id, period)` through
`beds.room_id` / `beds.ward_id`, `ix_staff_shifts_ward_period (ward_id, period)`,
`ex_appointments_doctor_overlap (doctor_id, period)`. Level 1 = 3 ms.

## BFS, window materialisation (once per call, when the frontier first exceeds 32)

Every branch of `v_presence` uses its GiST index on the window — the filter is pushed through the `UNION ALL`:
```
Append (actual rows=16275)                                             95 ms incl. insert
  Bitmap Index Scan on ix_admissions_bed_period        Index Cond: (tstzrange(admitted_at, discharged_at) && window)  rows=1223 (room) / 1223 (ward)
  Bitmap Index Scan on ix_staff_shifts_ward_period     Index Cond: (tstzrange(starts_at, ends_at) && window)          rows=3981
  Bitmap Index Scan on ix_appointments_patient_period  Index Cond: (tstzrange(starts_at, ends_at) && window)          rows=4924
  Index Scan using ex_appointments_doctor_overlap      Index Cond: ((doctor_id = st.doctor_id) AND (… && window))     rows=4924 (doctor side, Memoize)
```

## BFS, large frontier level (level 2: 67 → 623 new persons, 53 ms)

```
Unique → Sort (2483 candidate edges)
  Nested Loop Anti Join                               -- not yet visited
    Nested Loop
      Function Scan on q (frontier, 67)
      Index Scan using _graph_pres_person… on _graph_pres x    Index Cond: (person_id = q.id AND person_kind = q.kind)
      Index Scan using _graph_pres_place… on _graph_pres y     Index Cond: (place_id = x.place_id AND place_kind = x.place_kind)
                                                               Filter: (period && x.period)
    Index Only Scan using _graph_bfs_pkey on _graph_bfs b
```

## CTE + CYCLE (the naive SQL): why d3 takes 37 s

```
Recursive Union (actual rows=8 597 206 loops=1)                 30.7 s, temp read=240 066 written=240 066
  Hash Join (actual rows=2 149 301 loops=4)                       one row per PATH, not per person
    CTE Scan on pres y (rows=16 275)
    Hash ← Hash Join (rows=125 668) ← WorkTable Scan on walk (rows=10 618)
HashAggregate → 2 625 persons
```
`CYCLE` only stops a path from revisiting its own persons; different paths to the same person are never merged,
so the work grows with the number of paths (≈ branching^depth), not with the number of persons. At ×1:
d1 60 ms, d2 229 ms, d3 36.8 s; d4 / d5 exceed the 30 s benchmark timeout.

## Cost by depth and scale (validate.ts, 4 parallel sessions, 14-day window)

| Scale | BFS depth 3 p50 | BFS depth 5 p50 | persons active in window | d5 reached (p50) |
|---|---:|---:|---:|---:|
| ×1 | — (all 200 at depth 5) | 1 109 ms | 6 194 | 6 193 (100 %) |
| ×5 | 673 ms | 4 712 ms | 30 699 | 29 640 (96.6 %) |
| ×10 | 1 135 ms | 8 093 ms | 61 756 | 53 825 (87.2 %) |
