#!/usr/bin/env bash
# Full benchmark run for docs/07 (profile "report", see src/cli.ts). Run from packages/bench. ≈ 5 h on 4 vCPU.
# Each scale: load Neo4j with the matching PG bench database (prepare-graph), then the scenarios of that scale.
set -euo pipefail
PG=postgres://clinic:clinic@localhost:5434
run() { local scale=$1; shift; BENCH_DATABASE_URL=$PG/clinic_bench_$scale pnpm bench -- --profile report --scale "$scale" "$@"; }

# ×1 — the main comparison: every scenario
pnpm prepare-graph -- --db clinic_bench_x1
run x1 --scenario S1,S2,S3 --concurrency 1,8 --out results/x1-traversal.json
run x1 --scenario S4,S5 --concurrency 1,8,32 --out results/x1-flat.json
run x1 --scenario S6,S7 --out results/x1-sync.json
run x1 --scenario R1,R2,R3,R4 --concurrency 1,8,32 --out results/x1-redis.json

# ×5, ×10 — scaling of the traversals (concurrency 1), ETL time; cold vs warm on ×10
for s in x5 x10; do
  pnpm prepare-graph -- --db clinic_bench_$s
  run $s --scenario S1,S2,S3 --concurrency 1 --out results/$s-traversal.json
  run $s --scenario S7 --out results/$s-etl.json
done
run x10 --scenario S8 --out results/x10-cold.json
pnpm report
