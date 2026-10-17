import pg from 'pg';
import { databaseUrl } from './index';

// Counts of schema objects in `public` (extension-owned objects excluded).
const url = databaseUrl();
const client = new pg.Client({ connectionString: url });
await client.connect();

const notExtension = (oid: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = ${oid} AND d.deptype = 'e')`;

const { rows } = await client.query<{ label: string; n: number }>(`
  SELECT 'tables (relkind r)' AS label, count(*)::int AS n
  FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind = 'r'
  UNION ALL
  SELECT 'functions (incl. trigger functions)', count(*)::int
  FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
  WHERE s.nspname = 'public' AND p.prokind = 'f' AND ${notExtension('p.oid')}
  UNION ALL
  SELECT 'procedures', count(*)::int
  FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
  WHERE s.nspname = 'public' AND p.prokind = 'p' AND ${notExtension('p.oid')}
  UNION ALL
  SELECT 'functions + procedures', count(*)::int
  FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
  WHERE s.nspname = 'public' AND p.prokind IN ('f', 'p') AND ${notExtension('p.oid')}
  UNION ALL
  SELECT 'triggers (non-internal)', count(*)::int
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND NOT t.tgisinternal
  UNION ALL
  SELECT 'views', count(*)::int
  FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind = 'v'
  UNION ALL
  SELECT 'materialized views', count(*)::int
  FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind = 'm'
  UNION ALL
  SELECT 'views + materialized views', count(*)::int
  FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
  WHERE s.nspname = 'public' AND c.relkind IN ('v', 'm')
`);

const { rows: idx } = await client.query<{ label: string; n: number }>(`
  SELECT 'indexes: ' || am.amname
         || CASE WHEN bool_or(x.indisunique) AND bool_and(x.indisunique) THEN ' (all unique)' ELSE '' END AS label,
         count(*)::int AS n
  FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_namespace s ON s.oid = i.relnamespace
  JOIN pg_am am ON am.oid = i.relam
  WHERE s.nspname = 'public'
  GROUP BY am.amname
  UNION ALL
  SELECT 'indexes: unique (any method)', count(*)::int
  FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_namespace s ON s.oid = i.relnamespace
  WHERE s.nspname = 'public' AND x.indisunique
  UNION ALL
  SELECT 'indexes: partial', count(*)::int
  FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_namespace s ON s.oid = i.relnamespace
  WHERE s.nspname = 'public' AND x.indpred IS NOT NULL
  UNION ALL
  SELECT 'indexes: expression', count(*)::int
  FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_namespace s ON s.oid = i.relnamespace
  WHERE s.nspname = 'public' AND x.indexprs IS NOT NULL
  UNION ALL
  SELECT 'indexes: covering (INCLUDE)', count(*)::int
  FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_namespace s ON s.oid = i.relnamespace
  WHERE s.nspname = 'public' AND x.indnkeyatts < x.indnatts
`);

await client.end();

console.log(`Catalog of ${new URL(url).pathname.slice(1)} (schema public)`);
for (const r of [...rows, ...idx]) console.log(`  ${r.label.padEnd(38)} ${String(r.n).padStart(4)}`);
