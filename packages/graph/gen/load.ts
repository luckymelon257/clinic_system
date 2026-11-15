import { migrate, withDatabase } from '@clinic/db';
import pg from 'pg';
import { copyRows } from './copy';
import type { Dataset } from './model';

// Bulk load of a generated dataset into its own database (clinic_bench_x{N}):
// DROP / CREATE → migrate (no Lab 1 seeds) → COPY every table in one transaction with
// session_replication_role = replica (no audit / outbox / FK triggers; CHECK, UNIQUE and EXCLUDE still apply)
// → identity sequences → VACUUM ANALYZE → integrity checks for what replica mode skipped.

export interface LoadReport {
  database: string;
  tables: { table: string; rows: number; seconds: number }[];
  size: string;
  seconds: number;
  graphCounts: { kind: string; label: string; count: number }[];
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function recreateDatabase(url: string): Promise<void> {
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/^clinic_bench_[a-z0-9_]+$/.test(name)) throw new Error(`refusing to drop ${name}: bench databases are named clinic_bench_*`);
  await withClient(withDatabase(url, 'postgres'), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${name}"`);
  });
}

const overlap = (table: string, owner: string, f: string, t: string, where = 'true') => `
  SELECT count(*) FROM (
    SELECT ${f} AS f, lag(${t}) OVER (PARTITION BY ${owner} ORDER BY ${f}, ${t}) AS prev_t FROM ${table} WHERE ${where}
  ) x WHERE x.prev_t > x.f`;

/** Constraints that replica mode did not enforce. Throws with every violation found. */
export async function integrityChecks(c: pg.Client): Promise<void> {
  const problems: string[] = [];
  // every FK of the public schema (FK checks are triggers → skipped while loading)
  const { rows: fks } = await c.query<{ child: string; parent: string; name: string; ccols: string[]; pcols: string[] }>(`
    SELECT con.conrelid::regclass::text AS child, con.confrelid::regclass::text AS parent, con.conname AS name,
           array_agg(ca.attname::text ORDER BY k.ord) AS ccols, array_agg(pa.attname::text ORDER BY k.ord) AS pcols
    FROM pg_constraint con
    CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k (ck, pk, ord)
    JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = k.ck
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = k.pk
    WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace
    GROUP BY con.oid, con.conrelid, con.confrelid, con.conname`);
  for (const fk of fks) {
    const notNull = fk.ccols.map((col) => `c.${col} IS NOT NULL`).join(' AND ');
    const match = fk.ccols.map((col, i) => `p.${fk.pcols[i]} = c.${col}`).join(' AND ');
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${fk.child} c WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM ${fk.parent} p WHERE ${match})`);
    if (Number(rows[0]!.n)) problems.push(`${fk.name}: ${rows[0]!.n} orphan rows in ${fk.child}`);
  }
  const checks: [string, string][] = [
    // trg_admissions_bed_status did not run: bed status must follow active admissions
    ['bed status = occupied ⇔ active admission', `
      SELECT count(*) FROM beds b
      WHERE (b.status = 'occupied') <> EXISTS (SELECT 1 FROM admissions a WHERE a.bed_id = b.id AND a.status = 'active')`],
    // overlap invariants via lag() over each owner's rows ordered by start — linear, unlike a self-join.
    // A patient is never in two beds at once (no schema constraint, required for a sane graph);
    // beds / shifts / booked appointments are also EXCLUDE-protected, re-checked so the report shows them.
    ['no overlapping stays of one patient', overlap('admissions', 'patient_id', 'admitted_at', "coalesce(discharged_at, 'infinity')")],
    ['no overlapping stays on one bed', overlap('admissions', 'bed_id', 'admitted_at', "coalesce(discharged_at, 'infinity')")],
    ['no overlapping shifts of one person', overlap('staff_shifts', 'staff_id', 'starts_at', 'ends_at')],
    ['no overlapping booked appointments of one doctor',
      overlap('appointments', 'doctor_id', 'starts_at', 'ends_at', "status NOT IN ('cancelled', 'no_show')")],
    ['every bed has a room in its own ward', `
      SELECT count(*) FROM beds b LEFT JOIN rooms r ON r.id = b.room_id WHERE r.ward_id IS DISTINCT FROM b.ward_id`],
    ['attending doctor has a shift in the ward during every closed stay', `
      SELECT count(*) FROM admissions a JOIN beds b ON b.id = a.bed_id JOIN staff s ON s.doctor_id = a.doctor_id
      WHERE a.discharged_at - a.admitted_at >= interval '3 days'
        AND NOT EXISTS (SELECT 1 FROM staff_shifts sh WHERE sh.staff_id = s.id AND sh.ward_id = b.ward_id
                        AND tstzrange(sh.starts_at, sh.ends_at) && tstzrange(a.admitted_at, a.discharged_at))`],
    ['graph outbox is empty (bootstrap = full ETL)', 'SELECT count(*) FROM graph_outbox'],
  ];
  for (const [name, sql] of checks) {
    const { rows } = await c.query<{ count: string }>(sql);
    if (Number(rows[0]!.count)) problems.push(`${name}: ${rows[0]!.count} violations`);
  }
  if (problems.length) throw new Error(`integrity checks failed:\n  ${problems.join('\n  ')}`);
}

export async function loadDataset(url: string, ds: Dataset, log: (m: string) => void = console.log): Promise<LoadReport> {
  const t0 = Date.now();
  const database = new URL(url).pathname.slice(1);
  await recreateDatabase(url);
  await migrate(url);
  const tables: LoadReport['tables'] = [];
  await withClient(url, async (c) => {
    await c.query("SET TimeZone = 'Europe/Kyiv'");
    await c.query('SET session_replication_role = replica');
    await c.query('BEGIN');
    for (const tb of ds.tables) {
      const s = Date.now();
      const n = await copyRows(c, tb.name, tb.columns, tb.rows());
      tables.push({ table: tb.name, rows: n, seconds: (Date.now() - s) / 1000 });
      log(`  ${tb.name.padEnd(26)} ${String(n).padStart(10)} rows  ${((Date.now() - s) / 1000).toFixed(1)}s`);
    }
    await c.query('COMMIT');
    await c.query('SET session_replication_role = origin');
    const { rows: ids } = await c.query<{ t: string }>(`
      SELECT table_name AS t FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'id' AND is_identity = 'YES' AND table_name <> 'graph_outbox'`);
    for (const { t } of ids) {
      await c.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), greatest((SELECT max(id) FROM ${t}), 1))`);
    }
    log('  VACUUM ANALYZE …');
    await c.query('VACUUM ANALYZE');
    log('  integrity checks …');
    await integrityChecks(c);
  });
  return withClient(url, async (c) => {
    const size = (await c.query<{ s: string }>('SELECT pg_size_pretty(pg_database_size(current_database())) AS s')).rows[0]!.s;
    const graphCounts = (await c.query<{ kind: string; label: string; count: string }>('SELECT kind, label, count FROM v_graph_counts'))
      .rows.map((r) => ({ kind: r.kind, label: r.label, count: Number(r.count) }));
    return { database, tables, size, seconds: (Date.now() - t0) / 1000, graphCounts };
  });
}
