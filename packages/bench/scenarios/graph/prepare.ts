import { parseArgs } from 'node:util';
import { createDriver, fullEtl, neo4jConfigFromEnv } from '@clinic/graph';
import pg from 'pg';
import { assertSameDataset } from './common';

// Loads the bench Neo4j with one PG bench database (Neo4j Community = one database per instance, D-26), so the
// graph scenarios of a scale run against the same dataset in both engines. `--check` only verifies.
//   pnpm --filter @clinic/bench prepare-graph -- --db clinic_bench_x10 [--check]
// Neo4j: BENCH_NEO4J_URL / NEO4J_URL (default bolt://localhost:7688).

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: { db: { type: 'string', default: 'clinic_bench_x1' }, check: { type: 'boolean', default: false }, url: { type: 'string' } },
});
const url = values.url ?? `postgres://clinic:clinic@localhost:5434/${values.db}`;
const cfg = { ...neo4jConfigFromEnv(), url: process.env.BENCH_NEO4J_URL || process.env.NEO4J_URL || 'bolt://localhost:7688' };
const driver = createDriver(cfg);
const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  if (!values.check) {
    const r = await fullEtl(url, driver, { log: (m) => console.log(m) });
    console.log(`${values.db} → ${cfg.url}: ${(r.totalMs / 1000).toFixed(1)} s`);
  }
  await assertSameDataset(pool, driver);
  console.log(`OK: Neo4j ${cfg.url} holds ${values.db} (all v_graph_counts equal)`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
  await driver.close();
}
