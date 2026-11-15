import type { Driver } from 'neo4j-driver';
import pg from 'pg';
import { ensureSchema, wipeGraph } from '../neo4j/schema';

// Full ETL PostgreSQL → Neo4j (bootstrap, D-23). One REPEATABLE READ snapshot is read through server-side cursors
// (constant memory at ×10), each batch of 10 000 rows is written with one UNWIND statement, and while Neo4j writes
// batch k the next batch is already being fetched from PG. Afterwards every outbox event that was visible in the
// snapshot is acknowledged: its change is already in the loaded data. Events committed after the snapshot stay
// pending and are applied by the outbox worker (idempotent, D-32).

export const ETL_BATCH = 10_000;

export interface EtlStep {
  entity: string;
  rows: number;
  ms: number;
}

export interface EtlResult {
  steps: EtlStep[];
  totalMs: number;
  wipeMs: number;
  schemaMs: number;
  ackedEvents: number;
}

interface Step {
  entity: string;
  sql: string; // columns become UNWIND row keys
  cypher: string; // UNWIND $rows AS r …
}

const PERSON_LABEL = { patient: 'Patient', staff: 'Staff' } as const;
const PLACE_LABEL = { room: 'Room', ward: 'Ward', office: 'Office' } as const;

// Nodes first (constraints make the relationship lookups index seeks), then relationships.
const STEPS: Step[] = [
  {
    entity: 'Patient',
    sql: "SELECT person_id AS id, name FROM v_graph_persons WHERE person_kind = 'patient'",
    cypher: 'UNWIND $rows AS r CREATE (:Person:Patient {id: r.id, name: r.name})',
  },
  {
    entity: 'Staff',
    sql: "SELECT person_id AS id, name, role FROM v_graph_persons WHERE person_kind = 'staff'",
    cypher: 'UNWIND $rows AS r CREATE (:Person:Staff {id: r.id, name: r.name, role: r.role})',
  },
  {
    entity: 'Ward',
    sql: "SELECT place_id AS id, name, department_id AS \"departmentId\", ward_type AS type FROM v_graph_places WHERE place_kind = 'ward'",
    cypher: 'UNWIND $rows AS r CREATE (:Place:Ward {id: r.id, name: r.name, departmentId: r.departmentId, type: r.type})',
  },
  {
    entity: 'Room',
    sql: "SELECT place_id AS id, name, ward_id AS \"wardId\" FROM v_graph_places WHERE place_kind = 'room'",
    cypher: 'UNWIND $rows AS r CREATE (:Place:Room {id: r.id, name: r.name, wardId: r.wardId})',
  },
  {
    entity: 'Office',
    sql: "SELECT place_id AS id, name, department_id AS \"departmentId\" FROM v_graph_places WHERE place_kind = 'office'",
    cypher: 'UNWIND $rows AS r CREATE (:Place:Office {id: r.id, name: r.name, departmentId: r.departmentId})',
  },
  {
    // all medications incl. soft-deleted ones (v_medications hides them; v_graph_counts counts them)
    entity: 'Medication',
    sql: 'SELECT id, name FROM medications',
    cypher: 'UNWIND $rows AS r CREATE (:Medication {id: r.id, name: r.name})',
  },
  {
    entity: 'DrugClass',
    sql: 'SELECT id, code, name FROM v_drug_classes',
    cypher: 'UNWIND $rows AS r CREATE (:DrugClass {id: r.id, code: r.code, name: r.name})',
  },
  {
    entity: 'IN',
    sql: "SELECT place_id AS room, ward_id AS ward FROM v_graph_places WHERE place_kind = 'room'",
    cypher: 'UNWIND $rows AS r MATCH (a:Room {id: r.room}) MATCH (b:Ward {id: r.ward}) CREATE (a)-[:IN]->(b)',
  },
  ...(['patient', 'staff'] as const).flatMap((pk) =>
    (['room', 'ward', 'office'] as const).map((lk) => ({
      entity: `PRESENT ${pk}→${lk}`,
      sql: `SELECT person_id AS p, place_id AS l, fn_epoch_ms(f) AS f, fn_epoch_ms(t) AS t, src, src_id AS "srcId"
            FROM v_presence WHERE person_kind = '${pk}' AND place_kind = '${lk}'`,
      cypher: `UNWIND $rows AS r MATCH (a:${PERSON_LABEL[pk]} {id: r.p}) MATCH (b:${PLACE_LABEL[lk]} {id: r.l})
               CREATE (a)-[:PRESENT {f: r.f, t: r.t, src: r.src, srcId: r.srcId}]->(b)`,
    })),
  ),
  {
    entity: 'TAKES',
    sql: 'SELECT rx_item_id AS "rxId", patient_id AS p, medication_id AS m, fn_epoch_ms(f) AS f, fn_epoch_ms(t) AS t FROM v_takes',
    cypher: 'UNWIND $rows AS r MATCH (a:Patient {id: r.p}) MATCH (b:Medication {id: r.m}) CREATE (a)-[:TAKES {f: r.f, t: r.t, rxId: r.rxId}]->(b)',
  },
  {
    entity: 'IN_CLASS',
    sql: 'SELECT medication_id AS m, class_id AS c FROM v_medication_classes',
    cypher: 'UNWIND $rows AS r MATCH (a:Medication {id: r.m}) MATCH (b:DrugClass {id: r.c}) CREATE (a)-[:IN_CLASS]->(b)',
  },
  {
    entity: 'INTERACTS med',
    sql: 'SELECT medication_a AS a, medication_b AS b, severity::text AS severity FROM v_medication_interactions',
    cypher: 'UNWIND $rows AS r MATCH (a:Medication {id: r.a}) MATCH (b:Medication {id: r.b}) CREATE (a)-[:INTERACTS {severity: r.severity}]->(b)',
  },
  {
    entity: 'INTERACTS class',
    sql: 'SELECT class_a AS a, class_b AS b, severity::text AS severity FROM v_drug_class_interactions',
    cypher: 'UNWIND $rows AS r MATCH (a:DrugClass {id: r.a}) MATCH (b:DrugClass {id: r.b}) CREATE (a)-[:INTERACTS {severity: r.severity}]->(b)',
  },
];

// bigint columns (epoch ms, ids) arrive as strings from pg — convert to numbers before sending to Neo4j
function normalize(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  for (const r of rows) for (const k in r) if (typeof r[k] === 'string' && (k === 'f' || k === 't')) r[k] = Number(r[k]);
  return rows;
}

async function write(driver: Driver, cypher: string, rows: Record<string, unknown>[]): Promise<void> {
  const session = driver.session();
  try {
    await session.executeWrite((tx) => tx.run(cypher, { rows }));
  } finally {
    await session.close();
  }
}

export interface EtlOptions {
  batchSize?: number;
  log?: (msg: string) => void;
  /** Skip wiping (only for an empty database). */
  noWipe?: boolean;
}

export async function fullEtl(pgUrl: string, driver: Driver, o: EtlOptions = {}): Promise<EtlResult> {
  const batch = o.batchSize ?? ETL_BATCH;
  const log = o.log ?? (() => {});
  const t0 = performance.now();
  const steps: EtlStep[] = [];

  let w = performance.now();
  if (!o.noWipe) await wipeGraph(driver);
  const wipeMs = performance.now() - w;
  w = performance.now();
  await ensureSchema(driver);
  const schemaMs = performance.now() - w;

  const client = new pg.Client({ connectionString: pgUrl });
  await client.connect();
  let visibleEvents: string[] = [];
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // events visible in this snapshot = changes contained in the data we are about to load
    visibleEvents = (await client.query<{ id: string }>('SELECT id FROM graph_outbox WHERE processed_at IS NULL')).rows.map((r) => r.id);
    for (const [i, s] of STEPS.entries()) {
      const st = performance.now();
      const cursor = `etl_${i}`;
      await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${s.sql}`);
      const fetch = () => client.query(`FETCH ${batch} FROM ${cursor}`).then((r) => normalize(r.rows));
      let rows = 0;
      let next = fetch();
      for (;;) {
        const cur = await next;
        if (cur.length === 0) break;
        next = cur.length === batch ? fetch() : Promise.resolve([]); // fetch k+1 while writing k
        await write(driver, s.cypher, cur);
        rows += cur.length;
      }
      await client.query(`CLOSE ${cursor}`);
      const ms = performance.now() - st;
      steps.push({ entity: s.entity, rows, ms });
      log(`  ${s.entity.padEnd(22)} ${String(rows).padStart(9)} rows  ${(ms / 1000).toFixed(2)} s`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }

  // acknowledge the snapshot's events in a separate (writing) transaction
  const ack = new pg.Client({ connectionString: pgUrl });
  await ack.connect();
  try {
    for (let i = 0; i < visibleEvents.length; i += 50_000) {
      await ack.query('CALL sp_graph_outbox_ack($1::bigint[])', [visibleEvents.slice(i, i + 50_000)]);
    }
  } finally {
    await ack.end();
  }
  return { steps, totalMs: performance.now() - t0, wipeMs, schemaMs, ackedEvents: visibleEvents.length };
}
