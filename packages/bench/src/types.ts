// Scenario API shared by every benchmark (graph: S1–S8, redis: R1–R4). The harness owns timing,
// warm-up, concurrency, repetitions and interleaving; a scenario only says WHAT to run on each engine.

export type Engine = 'postgres' | 'neo4j' | 'redis';

/** One way to answer a variant on one engine (e.g. PG recursive CTE vs PG BFS are two ops of engine 'postgres'). */
export interface EngineOp {
  engine: Engine;
  /** Distinguishes several ops of the same engine; defaults to the engine name. */
  label?: string;
  /** Once before the first warm-up of this op (e.g. prepare statements, load a Lua script). */
  setup?(): Promise<void>;
  /**
   * One measured operation. `i` is the iteration index (0, 1, 2, …), identical for every engine, so
   * `params[i % params.length]` gives both engines the same parameter sequence. Must resolve only when the
   * full answer has been received (consume all rows / records).
   */
  run(i: number): Promise<unknown>;
  teardown?(): Promise<void>;
  /** Query plan for the report: EXPLAIN (ANALYZE, BUFFERS) for PG, PROFILE for Cypher. */
  explain?(): Promise<string>;
}

export interface Variant {
  id: string; // stable, e.g. 'x1-d3'
  label: string; // human readable, e.g. '×1, depth 3'
  params: Record<string, unknown>; // recorded verbatim in the results
  ops: EngineOp[];
  /** Override the scenario / global concurrency levels (e.g. writes that must stay sequential). */
  concurrency?: number[];
}

/** A table produced by a scenario that does not fit the latency loop (S6 lag, S7 ETL time, S8 cold vs warm). */
export interface CustomTable {
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
  /** Optional numeric series for an SVG line chart: x = first column, one line per listed column. */
  chart?: { x: string; y: string[]; yLabel: string; logY?: boolean };
}

export interface Scenario {
  id: string; // 'S1' … 'S8', 'R1' … 'R4'
  title: string;
  /** Why this scenario exists — the question the grader will ask. */
  why: string;
  /** What we expect and why. */
  expect: string;
  /** The observation that would falsify the expectation. */
  falsifiedIf: string;
  engines: Engine[];
  measure?: Partial<MeasureConfig>;
  /** Latency scenarios: the harness measures every op of every variant. */
  variants?(ctx: BenchContext): Promise<Variant[]>;
  /** Custom scenarios: the scenario measures itself and returns tables. */
  custom?(ctx: BenchContext): Promise<CustomTable[]>;
}

export interface MeasureConfig {
  warmupMs: number; // warm-up stops at whichever comes first: warmupMs or warmupIterations
  warmupIterations: number;
  minIterations: number; // measurement stops at whichever comes first: minIterations or maxMs …
  maxMs: number;
  minSamples: number; // … but never before minSamples completed iterations (slow queries)
  repetitions: number;
  concurrency: number[];
  timeoutMs: number; // per operation; PG statement_timeout / Neo4j tx timeout use the same value
}

export const DEFAULT_MEASURE: MeasureConfig = {
  warmupMs: 30_000,
  warmupIterations: 200,
  minIterations: 1000,
  maxMs: 60_000,
  minSamples: 10,
  repetitions: 3,
  concurrency: [1, 8, 32],
  timeoutMs: 30_000,
};

/** Engines and parameters handed to every scenario. Connections are created lazily by the harness. */
export interface BenchContext {
  scale: string; // 'x1' | 'x5' | 'x10' | 'golden' …
  params: unknown; // parsed params file (same file for both engines)
  paramsSha256: string;
  measure: MeasureConfig;
  engines: import('./engines').Engines;
  log(msg: string): void;
}

// ---------- results ----------
export interface RunStats {
  engine: Engine;
  label: string;
  concurrency: number;
  rep: number;
  n: number; // completed iterations (successful + timeouts)
  ok: number;
  timeouts: number;
  errors: number;
  firstError: string | null;
  wallMs: number;
  throughput: number; // completed ops / s over the measured wall time
  min: number;
  mean: number;
  p50: number; // ms; Infinity (serialised as null) if the quantile falls on a timeout
  p95: number;
  p99: number;
  max: number;
}

export interface VariantResult {
  id: string;
  label: string;
  params: Record<string, unknown>;
  runs: RunStats[];
  explain: Record<string, string>;
}

export interface ScenarioResult {
  id: string;
  title: string;
  why: string;
  expect: string;
  falsifiedIf: string;
  measure: MeasureConfig;
  variants: VariantResult[];
  tables: CustomTable[];
  error: string | null;
}

export interface BenchResults {
  schema: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  scale: string;
  paramsFile: string | null;
  paramsSha256: string;
  git: { commit: string | null; dirty: boolean | null };
  environment: Record<string, unknown>;
  scenarios: ScenarioResult[];
}
