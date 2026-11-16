#!/usr/bin/env bash
# Full benchmark run for docs/07 (profile "report", see src/cli.ts). Run from packages/bench. ≈ 5 h on 4 vCPU.
# Resumable: a step whose results file already exists is skipped, so after an interruption just run it again.
# Each scale: Neo4j is (re)loaded with the matching PG bench database only when it does not already hold it.
set -euo pipefail
PG=postgres://clinic:clinic@localhost:5434
graph() { pnpm prepare-graph -- --db "clinic_bench_$1" --check >/dev/null 2>&1 || pnpm prepare-graph -- --db "clinic_bench_$1"; }
step() {
  local scale=$1 out=$2; shift 2
  if [ -s "results/$out.json" ]; then echo "skip $out (exists)"; return; fi
  [ "${NEEDS_GRAPH:-1}" = 1 ] && graph "$scale"
  BENCH_DATABASE_URL=$PG/clinic_bench_$scale pnpm bench -- --profile report --scale "$scale" --out "results/$out.tmp.json" "$@"
  mv "results/$out.tmp.json" "results/$out.json"
}

# ×1 — the main comparison: every scenario
step x1 x1-traversal --scenario S1,S2,S3 --concurrency 1,8
step x1 x1-flat --scenario S4,S5 --concurrency 1,8,32
step x1 x1-sync --scenario S6,S7
NEEDS_GRAPH=0 step x1 x1-redis --scenario R1,R2,R3,R4 --concurrency 1,8,32

# ×5, ×10 — scaling of the traversals (concurrency 1), ETL time; cold vs warm on ×10
for s in x5 x10; do
  step $s $s-traversal --scenario S1,S2,S3 --concurrency 1
  step $s $s-etl --scenario S7
done
step x10 x10-cold --scenario S8
pnpm report
