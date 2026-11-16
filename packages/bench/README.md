# @clinic/bench — benchmark harness (Lab 2)

One Node process drives every engine with the same harness, the same params file and the same timeouts.
Scenarios only describe **what** to run; timing, warm-up, concurrency, repetitions and interleaving live in `src/runner.ts`.

```bash
pnpm bench --scale x1 --params params/x1.json --scenario S1,S4   # → results/<runId>-x1.json
pnpm bench --quick --scenario S1                                 # smoke run, never reported
pnpm bench:report                                                # results/*.json → report/<name>/README.md + charts/*.svg
```

Engines: `BENCH_DATABASE_URL` (default `clinic_bench_x1`), `BENCH_NEO4J_URL` (default `bolt://localhost:7688`),
`BENCH_REDIS_URL` (default DB 5) + `BENCH_REDIS_PREFIX` (default `bench`).

## Method (defaults in `src/types.ts` → `DEFAULT_MEASURE`)

| Step | Rule | Why |
|---|---|---|
| Warm-up | until 200 iterations **or** 30 s, before every measured run | JIT, plan cache, page cache / Neo4j page cache warm; repeated per run because the other engine ran in between |
| Measure | until 1000 iterations **or** 60 s, but at least 10 | fast queries get ≥ 1000 samples for a stable p99; slow ones are bounded in time |
| Load | closed loop, 1 / 8 / 32 concurrent clients sharing one iteration counter | latency at no contention, at the CPU count of the container, and under overload |
| Repetitions | 3, engine order rotated each repetition | slow drift (autovacuum, GC, thermal) hits every engine equally |
| Parameters | iteration `i` → `params[i % len]` — identical sequence for every engine | both engines answer exactly the same questions |
| Timeout | 30 s per operation (PG `statement_timeout`, Neo4j tx timeout); counted as `timeout` = +∞ | a quantile that lands on a timeout is reported as `timeout`, never silently dropped |
| Errors | the first non-timeout error stops the scenario | a wrong benchmark must not produce numbers |
| Statistics | nearest-rank p50 / p95 / p99, max, throughput; tables show the median over repetitions + p50 spread | every reported value is an observed latency |
| Provenance | results file stores git commit, params SHA-256, client machine, container limits, engine settings, EXPLAIN / PROFILE | a number without its setup is not evidence |

## Writing a scenario

```ts
export const s4: Scenario = {
  id: 'S4', title: 'Drug interaction check', engines: ['postgres', 'neo4j'],
  why: '…', expect: '…', falsifiedIf: '…',
  async variants(ctx) {
    const sets = (ctx.params as P).medSets[5];
    return [{ id: 'm5', label: '5 meds', params: { meds: 5 }, ops: [
      { engine: 'postgres', label: 'pg', run: (i) => ctx.engines.pg.query('SELECT * FROM fn_drug_interactions($1)', [sets[i % sets.length]]),
        explain: () => … },
      { engine: 'neo4j', run: (i) => ctx.engines.cypher(Q, { ids: sets[i % sets.length] }) }, // NoSQL op last → ratio = pg / neo4j
    ] }];
  },
};
```

`run(i)` must consume the full answer. Scenarios that are not a latency loop (outbox lag, ETL time, cold start)
implement `custom(ctx)` and return tables (optionally with a line chart).
