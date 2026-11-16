# Bench data generator (`pnpm --filter @clinic/graph gen -- --scale 1|5|10`)

Builds `clinic_bench_x{N}` from scratch: DROP / CREATE → migrations (no Lab 1 seeds) → `COPY … FROM STDIN` of every
table in one transaction with `session_replication_role = replica` (no audit / outbox / FK triggers; CHECK, UNIQUE
and EXCLUDE still enforced) → identity sequences → `VACUUM ANALYZE` → integrity checks for everything replica mode
skipped (all FKs, bed status ⇔ active admission, no overlapping stays per patient / bed, shifts per person,
booked appointments per doctor, bed's room in its ward, attending doctor on shift during stays ≥ 3 d, empty outbox).
Any violation fails the run. Deterministic: mulberry32, seed `2026 + scale`, one independent stream per section.

## Scenario → numbers (per hospital; ×N = N hospitals)

| Quantity | Value | Derivation |
|---|---|---|
| Beds | 400 | 16 wards × 6 rooms × 4 beds = 384 + 2 ICU wards × 8 single rooms = 16 |
| Departments | 8 | 7 with 3/3/2/2/2/2/2 general wards + ICU |
| Length of stay | log-normal, median 3.5 d, mean 5 d | μ = ln 3.5, σ = √(2·ln(5/3.5)) ≈ 0.845; clipped to [0.25, 60] d |
| Bed turnover gap | exponential, mean 1.1 d | admissions / discharges are moved into 08:00–22:00, which lengthens the cycle; 1.1 d gives occupancy ≈ 80 % |
| Admissions | ≈ 64 / day → 23 360 / year | 400 beds × 0.8 / 5 d; generated: **23 760 (65.1 / day), occupancy 80.8 %** |
| Readmissions | 15 % | patient discharged earlier in the same hospital, recent discharges favoured |
| Patients | 64 000 | ≈ 20 k inpatients + outpatients; appointments draw uniformly from the pool |
| Doctors | 60 | 54 with a home general ward (3–4 per ward) + 6 ICU; attending = a home doctor of the stay's ward |
| Nurses | 300 | ICU 22 per ward (1 : 2 beds per shift), 10 % department floats, ×5 / ×10: 3 % network floats, rest fixed |
| Nurse rota | 2D-2E-2N-2off | D 07–15, E 15–23, N 23–07; random phase per nurse → 300 × 365 × 6/8 ≈ 82 k shifts |
| Doctor shifts | 08–16 on weekdays in the home ward | 60 × 261 ≈ 15.7 k |
| On-call | per department per day | weekdays 20:00–08:00, weekends 08–20 + 20–08 (two shifts: a 24 h shift is 25 h on the DST night and violates `ck_staff_shifts_length`) |
| Clinic | weekdays 16:00–20:00, 20-min slots, 80 % filled | 60 × 261 × 12 × 0.8 ≈ 150 k appointments; 85 / 8 / 7 % completed / cancelled / no-show |
| Cross-site (×5, ×10) | 5 % of clinic sessions | the session's patients come from another hospital's pool |
| Medical records | 1 per completed appointment + 1 per admission | ≈ 128 k + 23.8 k |
| Prescriptions | 60 % of visits (1–4 items, mean 2.05) + every admission (1–5, mean 2.6) | ≈ 157 k + 62 k ≈ 219 k items (target ≈ 213 k) |
| Medications / classes | 600 / 80, network-wide (not ×N) | 85 % one class, 15 % two; Zipf(0.9) prescription popularity |
| Interactions | 550 | 350 medication–medication + 170 class–class + 30 same-class (duplication), severity ≈ 30 / 50 / 20 % minor / moderate / major |

Time is local wall-clock (`Europe/Kyiv`), one year from 2025-11-01; no generated boundary falls into 03:00–04:00, the
only ambiguous / missing local hour around DST changes. Stays still open at the end of the year are `active` with
`discharged_at = NULL` (≈ 314 at ×1 — exactly the occupied beds).

Not generated (not used by the graph or the benchmarks): diagnoses, lab, invoices, payments, insurances, users other
than doctors' accounts.
