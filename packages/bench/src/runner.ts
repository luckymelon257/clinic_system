import { summarize } from './stats';
import type { EngineOp, MeasureConfig, RunStats, Variant, VariantResult } from './types';

/** Harness-side guard; normally the engine's own timeout (statement_timeout / tx timeout) fires first. */
export class OpTimeoutError extends Error {
  constructor(ms: number) {
    super(`operation exceeded ${ms} ms`);
  }
}

/** PG statement_timeout (57014 query_canceled), Neo4j transaction timeout, or the harness guard. */
export function isTimeout(e: unknown): boolean {
  if (e instanceof OpTimeoutError) return true;
  const code = (e as { code?: unknown })?.code;
  if (code === '57014') return true;
  return typeof code === 'string' && code.includes('TransactionTimedOut');
}

const now = () => Number(process.hrtime.bigint()) / 1e6; // ms, monotonic

function withGuard<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OpTimeoutError(ms)), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

export interface DriveOptions {
  concurrency: number;
  iterations: number; // stop issuing after this many …
  maxMs: number; // … or after this much wall time, whichever comes first …
  minSamples: number; // … but not before this many have completed
  timeoutMs: number;
}

export interface DriveResult {
  latencies: number[];
  timeouts: number;
  errors: number;
  firstError: string | null;
  wallMs: number;
}

/**
 * Runs `op` from `concurrency` async workers sharing one iteration counter (closed loop: a worker issues the
 * next operation as soon as its previous one completes). Iteration indices are 0, 1, 2, … in issue order.
 * The first non-timeout error stops the run (a wrong benchmark must not produce numbers).
 */
export async function drive(op: EngineOp, o: DriveOptions): Promise<DriveResult> {
  const latencies: number[] = [];
  let timeouts = 0;
  let errors = 0;
  let firstError: string | null = null;
  let issued = 0;
  let completed = 0;
  const t0 = now();
  const guardMs = o.timeoutMs + 5_000;

  const keepGoing = () => {
    if (errors > 0 || issued >= o.iterations) return false;
    return completed < o.minSamples || now() - t0 < o.maxMs;
  };

  const worker = async () => {
    while (keepGoing()) {
      const i = issued++;
      const s = now();
      try {
        await withGuard(op.run(i), guardMs);
        latencies.push(now() - s);
      } catch (e) {
        if (isTimeout(e)) timeouts++;
        else {
          errors++;
          firstError ??= e instanceof Error ? e.message : String(e);
        }
      }
      completed++;
    }
  };

  await Promise.all(Array.from({ length: o.concurrency }, worker));
  return { latencies, timeouts, errors, firstError, wallMs: now() - t0 };
}

export const opLabel = (op: EngineOp) => op.label ?? op.engine;

/** rep 0: [a, b, c]; rep 1: [b, c, a]; rep 2: [c, a, b] — every engine runs first, second, … equally often. */
export function interleave<T>(ops: readonly T[], rep: number): T[] {
  const k = ops.length ? rep % ops.length : 0;
  return [...ops.slice(k), ...ops.slice(0, k)];
}

export async function runVariant(
  variant: Variant,
  measure: MeasureConfig,
  log: (msg: string) => void = () => {},
): Promise<VariantResult> {
  const runs: RunStats[] = [];
  const explain: Record<string, string> = {};
  for (const op of variant.ops) await op.setup?.();
  try {
    for (const c of variant.concurrency ?? measure.concurrency) {
      for (let rep = 0; rep < measure.repetitions; rep++) {
        for (const op of interleave(variant.ops, rep)) {
          const label = opLabel(op);
          await drive(op, {
            concurrency: c,
            iterations: measure.warmupIterations,
            maxMs: measure.warmupMs,
            minSamples: 0,
            timeoutMs: measure.timeoutMs,
          });
          const r = await drive(op, {
            concurrency: c,
            iterations: measure.minIterations,
            maxMs: measure.maxMs,
            minSamples: measure.minSamples,
            timeoutMs: measure.timeoutMs,
          });
          const s = summarize(r.latencies, r.timeouts);
          const n = r.latencies.length + r.timeouts;
          runs.push({
            engine: op.engine,
            label,
            concurrency: c,
            rep,
            n,
            ok: r.latencies.length,
            timeouts: r.timeouts,
            errors: r.errors,
            firstError: r.firstError,
            wallMs: r.wallMs,
            throughput: r.wallMs > 0 ? (n / r.wallMs) * 1000 : 0,
            min: s.min,
            mean: s.mean,
            p50: s.p50,
            p95: s.p95,
            p99: s.p99,
            max: s.max,
          });
          log(`  ${variant.id} ${label} c=${c} rep=${rep + 1}: n=${n} p50=${s.p50.toFixed(3)}ms p99=${s.p99.toFixed(3)}ms` +
            (r.timeouts ? ` timeouts=${r.timeouts}` : '') + (r.errors ? ` ERROR ${r.firstError}` : ''));
          if (r.errors) throw new Error(`${variant.id} ${label}: ${r.firstError}`);
        }
      }
    }
    for (const op of variant.ops) {
      if (op.explain) explain[opLabel(op)] = await op.explain();
    }
  } finally {
    for (const op of variant.ops) await op.teardown?.();
  }
  return { id: variant.id, label: variant.label, params: variant.params, runs, explain };
}
