import { parseArgs } from 'node:util';
import { Engines, engineConfigFromEnv } from './engines';
import { runBench, saveResults } from './bench';
import { loadParams } from './params';
import { pick } from './registry';
import { DEFAULT_MEASURE, type MeasureConfig } from './types';

// pnpm bench [--scale x1] [--params params/x1.json] [--scenario S1,S4] [--quick] [--concurrency 1,8,32] [--reps 3] [--out file]
// Engines come from BENCH_DATABASE_URL / BENCH_NEO4J_URL / BENCH_REDIS_URL (see engines.ts).

// `pnpm bench -- --scale x1` passes a literal '--' through to the script; drop it
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    scale: { type: 'string', default: 'x1' },
    params: { type: 'string' },
    scenario: { type: 'string' },
    quick: { type: 'boolean', default: false },
    profile: { type: 'string', default: 'spec' }, // spec = DEFAULT_MEASURE; report = time-bounded profile used for docs/07
    concurrency: { type: 'string' },
    reps: { type: 'string' },
    out: { type: 'string' },
    variant: { type: 'string' }, // comma-separated variant ids, e.g. d1,d2
  },
});

// --quick: smoke run to check that a scenario works end-to-end; its numbers are never reported
const QUICK: Partial<MeasureConfig> = { warmupMs: 2_000, warmupIterations: 20, minIterations: 100, maxMs: 5_000, minSamples: 3, repetitions: 1, concurrency: [1, 8] };

// --profile report: the profile actually used for docs/07 (reason: the spec profile needs ≈ 17 h of machine time for
// ×1/×5/×10, almost all of it 60-s time caps on multi-second traversals; see docs/07 §3). Same rules, smaller caps.
const REPORT: Partial<MeasureConfig> = { warmupMs: 10_000, warmupIterations: 100, minIterations: 500, maxMs: 30_000, minSamples: 5 };

const measure: MeasureConfig = {
  ...DEFAULT_MEASURE,
  ...(values.profile === 'report' ? REPORT : {}),
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
  const results = await runBench(selected, { scale: values.scale!, params, measure, engines, variants: values.variant?.split(',') });
  const out = values.out ?? `results/${results.runId}-${values.scale}${values.quick ? '-quick' : ''}.json`;
  saveResults(out, results);
  console.log(`results → ${out}`);
  if (results.scenarios.some((s) => s.error)) process.exitCode = 1;
} finally {
  await engines.close();
}
