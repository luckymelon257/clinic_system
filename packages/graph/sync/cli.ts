import { parseArgs } from 'node:util';
import { databaseUrl } from '@clinic/db';
import pg from 'pg';
import { createDriver, neo4jConfigFromEnv } from '../neo4j/driver';
import { graphCounts } from '../neo4j/queries';
import { fullEtl } from './etl';
import { runWorker, syncStatus } from './worker';

// pnpm graph:sync --full            full ETL PG → Neo4j, then exit
// pnpm graph:sync --follow          outbox worker until Ctrl+C
// pnpm graph:sync --full --follow   both
// Env: DATABASE_URL (repo .env), NEO4J_URL / NEO4J_USER / NEO4J_PASSWORD.

const { values } = parseArgs({
  options: {
    full: { type: 'boolean', default: false },
    follow: { type: 'boolean', default: false },
    batch: { type: 'string', default: '500' },
  },
});
if (!values.full && !values.follow) {
  console.error('usage: sync --full | --follow | --full --follow');
  process.exit(1);
}

const url = databaseUrl();
const neo = neo4jConfigFromEnv();
const driver = createDriver(neo);
const pool = new pg.Pool({ connectionString: url, max: 2 });
const db = new URL(url).pathname.slice(1);

try {
  if (values.full) {
    console.log(`[${db} → ${neo.url}] full ETL`);
    const r = await fullEtl(url, driver, { log: console.log });
    console.log(`wipe ${(r.wipeMs / 1000).toFixed(2)} s, schema ${(r.schemaMs / 1000).toFixed(2)} s, total ${(r.totalMs / 1000).toFixed(2)} s, acked ${r.ackedEvents} outbox events`);
    const expected = (await pool.query<{ kind: string; label: string; count: string }>('SELECT kind, label, count FROM v_graph_counts')).rows;
    const actual = await graphCounts(driver);
    let ok = true;
    for (const e of expected) {
      const a = actual.find((x) => x.kind === e.kind && x.label === e.label)?.count;
      const same = a === Number(e.count);
      ok &&= same;
      console.log(`  ${same ? '=' : '≠'} ${e.kind} ${e.label.padEnd(10)} pg ${String(e.count).padStart(9)}  neo4j ${String(a).padStart(9)}`);
    }
    if (!ok) {
      console.error('graph counts differ from v_graph_counts');
      process.exitCode = 1;
    }
  }
  if (values.follow) {
    const ac = new AbortController();
    process.once('SIGINT', () => ac.abort());
    process.once('SIGTERM', () => ac.abort());
    console.log(`[${db} → ${neo.url}] outbox worker, Ctrl+C to stop`);
    let applied = 0;
    const report = setInterval(async () => {
      const s = await syncStatus(pool).catch(() => null);
      if (s) console.log(`  applied ${applied}, pending ${s.pending}, lag ${s.lagMs} ms`);
    }, 10_000);
    await runWorker({ pool, driver, signal: ac.signal, batch: Number(values.batch), log: console.error, onBatch: (r) => { applied += r.applied; } });
    clearInterval(report);
  }
} finally {
  await pool.end();
  await driver.close();
}
