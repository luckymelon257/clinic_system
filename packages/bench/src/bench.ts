import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Engines } from './engines';
import { captureEnvironment, gitInfo } from './env';
import type { LoadedParams } from './params';
import { runVariant } from './runner';
import type { BenchResults, Engine, MeasureConfig, Scenario, ScenarioResult } from './types';

export interface BenchOptions {
  scale: string;
  params: LoadedParams;
  measure: MeasureConfig;
  engines: Engines;
  log?: (msg: string) => void;
}

/** Runs the scenarios one after another in one Node process and returns the full results document. */
export async function runBench(scenarios: readonly Scenario[], o: BenchOptions): Promise<BenchResults> {
  const log = o.log ?? ((m: string) => console.log(m));
  const startedAt = new Date().toISOString();
  const used = new Set<Engine>(scenarios.flatMap((s) => s.engines));
  const environment = await captureEnvironment(o.engines, used);
  const results: ScenarioResult[] = [];

  for (const sc of scenarios) {
    const measure = { ...o.measure, ...sc.measure };
    const ctx = { scale: o.scale, params: o.params.data, paramsSha256: o.params.sha256, measure, engines: o.engines, log };
    const r: ScenarioResult = {
      id: sc.id, title: sc.title, why: sc.why, expect: sc.expect, falsifiedIf: sc.falsifiedIf,
      measure, variants: [], tables: [], error: null,
    };
    log(`${sc.id} ${sc.title}`);
    try {
      if (sc.variants) {
        for (const v of await sc.variants(ctx)) r.variants.push(await runVariant(v, measure, log));
      }
      if (sc.custom) r.tables.push(...(await sc.custom(ctx)));
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e);
      log(`${sc.id} FAILED: ${r.error}`);
    }
    results.push(r);
  }

  return {
    schema: 1,
    runId: startedAt.replace(/[:.]/g, '-'),
    startedAt,
    finishedAt: new Date().toISOString(),
    scale: o.scale,
    paramsFile: o.params.file,
    paramsSha256: o.params.sha256,
    git: gitInfo(),
    environment,
    scenarios: results,
  };
}

// JSON has no Infinity; a quantile that landed on a timeout is stored as the string "Infinity".
const replacer = (_k: string, v: unknown) => (v === Infinity ? 'Infinity' : v);
const reviver = (_k: string, v: unknown) => (v === 'Infinity' ? Infinity : v);

export function saveResults(file: string, r: BenchResults): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(r, replacer, 2) + '\n');
}

export function loadResults(file: string): BenchResults {
  const r = JSON.parse(readFileSync(file, 'utf8'), reviver) as BenchResults;
  if (r.schema !== 1) throw new Error(`${file}: unsupported results schema ${String(r.schema)}`);
  return r;
}
