#!/usr/bin/env bash
# Full benchmark run for docs/07 (profile "report", see src/cli.ts). Run from packages/bench. ≈ 5 h on 4 vCPU.
# Resumable: every step (one scenario variant, a few minutes) writes results/<group>__<NN-step>.json; a step whose
# file exists is skipped, so after an interruption just run the script again. `pnpm report` merges each group.
# Neo4j is (re)loaded with the matching PG bench database only when it does not already hold it.
set -euo pipefail
PG=postgres://clinic:clinic@localhost:5434
graph() { pnpm prepare-graph -- --db "clinic_bench_$1" --check >/dev/null 2>&1 || pnpm prepare-graph -- --db "clinic_bench_$1"; }
step() { # step <scale> <group> <name> <graph 0|1> <bench args…>
  local scale=$1 group=$2 name=$3 needs=$4; shift 4
  local out="results/${group}__${name}.json"
  if [ -s "$out" ]; then echo "skip $out"; return; fi
  [ "$needs" = 1 ] && graph "$scale"
  BENCH_DATABASE_URL=$PG/clinic_bench_$scale pnpm bench -- --profile report --scale "$scale" --out "$out.tmp" "$@"
  mv "$out.tmp" "$out"
}
variants() { # variants <scale> <group> <scenario> <concurrency> <ids…>
  local scale=$1 group=$2 sc=$3 c=$4; shift 4
  local n=0
  for v in "$@"; do n=$((n + 1)); step "$scale" "$group" "${sc}-$(printf %02d $n)-$v" 1 --scenario "$sc" --variant "$v" --concurrency "$c"; done
}

# ×1 — the main comparison: every scenario
variants x1 x1-traversal S1 1,8 d1 d2 d3 d4 d5
variants x1 x1-traversal S2 1,8 d3 d14 d60
variants x1 x1-traversal S3 1,8 d2 d4 unreachable
variants x1 x1-flat S4 1,8,32 m1 m5 m15 patient
variants x1 x1-flat S5 1,8,32 r0 r1
step x1 x1-sync S6 1 --scenario S6
step x1 x1-sync S7 1 --scenario S7
for r in R1 R2 R3 R4; do step x1 x1-redis "$r" 0 --scenario "$r" --concurrency 1,8,32; done

# ×5, ×10 — scaling of the traversals (concurrency 1), ETL time; cold vs warm on ×10
for s in x5 x10; do
  variants $s $s-traversal S1 1 d1 d2 d3 d4 d5
  variants $s $s-traversal S2 1 d3 d14 d60
  variants $s $s-traversal S3 1 d2 d4 unreachable
  step $s $s-etl S7 1 --scenario S7
done
step x10 x10-cold S8 1 --scenario S8
pnpm report
