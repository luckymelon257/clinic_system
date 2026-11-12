import { parseArgs } from 'node:util';
import { Engines, engineConfigFromEnv } from './engines';
import { runBench, saveResults } from './bench';
import { loadParams } from './params';
import { pick } from './registry';
import { DEFAULT_MEASURE, type MeasureConfig } from './types';

// pnpm bench [--scale x1] [--params params/x1.json] [--scenario S1,S4] [--quick] [--concurrency 1,8,32] [--reps 3] [--out file]
// Engines come from BENCH_DATABASE_URL / BENCH_NEO4J_URL / BENCH_REDIS_URL (see engines.ts).

const { values } = parseArgs({
  options: {
    scale: { type: 'string', default: 'x1' },
    params: { type: 'string' },
    scenario: { type: 'string' },
    quick: { type: 'boolean', default: false },
    concurrency: { type: 'string' },
    reps: { type: 'string' },
    out: { type: 'string' },
  },
});

// --quick: smoke run to check that a scenario works end-to-end; its numbers are never reported
const QUICK: Partial<MeasureConfig> = { warmupMs: 2_000, warmupIterations: 20, minIterations: 100, maxMs: 5_000, minSamples: 3, repetitions: 1, concurrency: [1, 8] };

const measure: MeasureConfig = {
  ...DEFAULT_MEASURE,
  ...(values.quick ? QUICK : {}),
  ...(values.concurrency ? { concurrency: values.concurrency.split(',').map(Number) } : {}),
  ...(values.reps ? { repetitions: Number(values.reps) } : {}),
};
const selected = pick(values.scenario ? values.scenario.split(',') : null);
if (selected.length === 0) {
  console.error('no scenarios registered yet (scenarios/graph, scenarios/redis)');
  process.exit(1);
}
const params = loadParams(values.params ?? null);
const engines = new Engines(engineConfigFromEnv(measure.timeoutMs, Math.max(...measure.concurrency) + 8));
try {
  const results = await runBench(selected, { scale: values.scale!, params, measure, engines });
  const out = values.out ?? `results/${results.runId}-${values.scale}${values.quick ? '-quick' : ''}.json`;
  saveResults(out, results);
  console.log(`results → ${out}`);
  if (results.scenarios.some((s) => s.error)) process.exitCode = 1;
} finally {
  await engines.close();
}
