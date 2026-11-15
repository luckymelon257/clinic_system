import type { Driver, ManagedTransaction } from 'neo4j-driver';
import type pg from 'pg';
import { int } from '../neo4j/driver';

// Outbox worker (D-23, D-32): claim a batch of graph_outbox events (SKIP LOCKED), apply them to Neo4j in id order
// inside ONE Neo4j transaction, then acknowledge them in PG. Every event is a snapshot of its source row, so applying
// it twice yields the same graph (MERGE by id; presence / takes / class membership are replaced as a whole).
// If Neo4j fails, the batch is acked with the error and goes back to the queue (claimed_at = NULL).

export interface OutboxEvent {
  id: string; // bigint
  entity: string;
  entity_key: string;
  op: 'upsert' | 'delete';
  payload: Record<string, unknown>;
  created_at: Date;
}

const PERSON = { patient: 'Patient', staff: 'Staff' } as const;
const PLACE = { room: 'Room', ward: 'Ward', office: 'Office' } as const;
type PersonKind = keyof typeof PERSON;
type PlaceKind = keyof typeof PLACE;

interface Edge {
  personKind: PersonKind;
  personId: number;
  placeKind: PlaceKind;
  placeId: number;
  f: number;
  t: number;
}

// ids and epoch ms → Neo4j INTEGER (see int() in neo4j/driver.ts)
const num = (v: unknown) => int(v as number | string);

async function applyOne(tx: ManagedTransaction, e: OutboxEvent): Promise<void> {
  const p = e.payload;
  const del = e.op === 'delete';
  switch (e.entity) {
    case 'patient':
      if (del) await tx.run('MATCH (n:Patient {id: $id}) DETACH DELETE n', { id: num(p.id) });
      else await tx.run('MERGE (n:Patient {id: $id}) SET n:Person, n.name = $name', { id: num(p.id), name: p.name });
      return;
    case 'staff':
      if (del) await tx.run('MATCH (n:Staff {id: $id}) DETACH DELETE n', { id: num(p.id) });
      else await tx.run('MERGE (n:Staff {id: $id}) SET n:Person, n.name = $name, n.role = $role', { id: num(p.id), name: p.name, role: p.role });
      return;
    case 'ward':
      if (del) await tx.run('MATCH (n:Ward {id: $id}) DETACH DELETE n', { id: num(p.id) });
      else await tx.run('MERGE (n:Ward {id: $id}) SET n:Place, n.name = $name, n.departmentId = $dep, n.type = $type',
        { id: num(p.id), name: p.name, dep: num(p.departmentId), type: p.type });
      return;
    case 'room':
      if (del) await tx.run('MATCH (n:Room {id: $id}) DETACH DELETE n', { id: num(p.id) });
      else await tx.run(`MERGE (n:Room {id: $id}) SET n:Place, n.name = $name, n.wardId = $wardId
        WITH n OPTIONAL MATCH (n)-[old:IN]->() DELETE old
        WITH DISTINCT n MERGE (w:Ward {id: $wardId}) ON CREATE SET w:Place MERGE (n)-[:IN]->(w)`,
        { id: num(p.id), name: p.name, wardId: num(p.wardId) });
      return;
    case 'office':
      if (del) await tx.run('MATCH (n:Office {id: $id}) DETACH DELETE n', { id: num(p.id) });
      else await tx.run('MERGE (n:Office {id: $id}) SET n:Place, n.departmentId = $dep, n.name = coalesce($name, n.name)', { id: num(p.id), dep: num(p.departmentId), name: p.name ?? null });
      return;
    case 'presence': {
      // replace ALL edges of this source row (a cancelled appointment carries an empty list)
      await tx.run('MATCH ()-[r:PRESENT {src: $src, srcId: $srcId}]->() DELETE r', { src: p.src, srcId: num(p.srcId) });
      for (const ed of (p.edges as Edge[] | undefined) ?? []) {
        await tx.run(`MERGE (a:${PERSON[ed.personKind]} {id: $pid}) ON CREATE SET a:Person
          MERGE (b:${PLACE[ed.placeKind]} {id: $lid}) ON CREATE SET b:Place
          CREATE (a)-[:PRESENT {f: $f, t: $t, src: $src, srcId: $srcId}]->(b)`,
        { pid: num(ed.personId), lid: num(ed.placeId), f: num(ed.f), t: num(ed.t), src: p.src, srcId: num(p.srcId) });
      }
      return;
    }
    case 'takes':
      await tx.run('MATCH ()-[r:TAKES {rxId: $rx}]->() DELETE r', { rx: num(p.rxItemId) });
      if (!del && p.patientId != null) {
        await tx.run(`MERGE (a:Patient {id: $pid}) ON CREATE SET a:Person MERGE (m:Medication {id: $mid})
          CREATE (a)-[:TAKES {f: $f, t: $t, rxId: $rx}]->(m)`,
        { pid: num(p.patientId), mid: num(p.medicationId), f: num(p.f), t: num(p.t), rx: num(p.rxItemId) });
      }
      return;
    case 'medication':
      if (del) await tx.run('MATCH (n:Medication {id: $id}) DETACH DELETE n', { id: num(p.id) });
      else await tx.run('MERGE (n:Medication {id: $id}) SET n.name = $name', { id: num(p.id), name: p.name });
      return;
    case 'drug_class':
      if (del) await tx.run('MATCH (n:DrugClass {id: $id}) DETACH DELETE n', { id: num(p.id) });
      else await tx.run('MERGE (n:DrugClass {id: $id}) SET n.code = $code, n.name = $name', { id: num(p.id), code: p.code, name: p.name });
      return;
    case 'medication_class':
      await tx.run(`MERGE (m:Medication {id: $mid}) WITH m OPTIONAL MATCH (m)-[r:IN_CLASS]->() DELETE r
        WITH DISTINCT m UNWIND $classIds AS cid MERGE (c:DrugClass {id: cid}) CREATE (m)-[:IN_CLASS]->(c)`,
      { mid: num(p.medicationId), classIds: ((p.classIds as unknown[]) ?? []).map(num) });
      return;
    case 'medication_interaction':
    case 'class_interaction': {
      const L = e.entity === 'medication_interaction' ? 'Medication' : 'DrugClass';
      const [a, b] = e.entity_key.split(':').map(num);
      await tx.run(`MATCH (a:${L} {id: $a})-[r:INTERACTS]-(b:${L} {id: $b}) WITH DISTINCT r DELETE r`, { a, b });
      if (!del) {
        await tx.run(`MERGE (a:${L} {id: $a}) MERGE (b:${L} {id: $b}) CREATE (a)-[:INTERACTS {severity: $sev}]->(b)`,
          { a, b, sev: p.severity });
      }
      return;
    }
    default:
      throw new Error(`unknown outbox entity ${e.entity}`);
  }
}

/** Applies events (already sorted by id) in one Neo4j write transaction. */
export async function applyBatch(driver: Driver, events: readonly OutboxEvent[]): Promise<void> {
  if (events.length === 0) return;
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      for (const e of events) await applyOne(tx, e);
    });
  } finally {
    await session.close();
  }
}

export interface DrainResult {
  claimed: number;
  applied: number;
  failed: number;
  /** created_at → ack latency of every applied event, ms */
  lagsMs: number[];
}

/** Claims and applies one batch; returns what happened (claimed = 0 → queue empty). */
export async function drainOnce(pool: pg.Pool, driver: Driver, worker: string, limit = 500): Promise<DrainResult> {
  const { rows } = await pool.query<OutboxEvent>('SELECT id, entity, entity_key, op, payload, created_at FROM fn_graph_outbox_claim($1, $2)', [worker, limit]);
  if (rows.length === 0) return { claimed: 0, applied: 0, failed: 0, lagsMs: [] };
  rows.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const ids = rows.map((r) => r.id);
  try {
    await applyBatch(driver, rows);
  } catch (err) {
    await pool.query('CALL sp_graph_outbox_ack($1::bigint[], $2)', [ids, err instanceof Error ? err.message : String(err)]);
    return { claimed: rows.length, applied: 0, failed: rows.length, lagsMs: [] };
  }
  await pool.query('CALL sp_graph_outbox_ack($1::bigint[])', [ids]);
  const now = Date.now();
  return { claimed: rows.length, applied: rows.length, failed: 0, lagsMs: rows.map((r) => now - r.created_at.getTime()) };
}

export interface WorkerOptions {
  pool: pg.Pool;
  driver: Driver;
  signal?: AbortSignal;
  worker?: string;
  batch?: number;
  /** idle poll interval, doubles up to maxIdleMs while the queue is empty */
  idleMs?: number;
  maxIdleMs?: number;
  onBatch?: (r: DrainResult) => void;
  log?: (msg: string) => void;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

/**
 * Runs until `signal` aborts. A full batch is followed immediately by the next claim; an empty queue backs off
 * from idleMs (100 ms) to maxIdleMs (1 s) — worst-case pickup delay stays well inside the 5 s lag budget (BR-11).
 */
export async function runWorker(o: WorkerOptions): Promise<void> {
  const worker = o.worker ?? `worker-${process.pid}`;
  const batch = o.batch ?? 500;
  const idle = o.idleMs ?? 100;
  const maxIdle = o.maxIdleMs ?? 1_000;
  let wait = idle;
  while (!o.signal?.aborted) {
    let r: DrainResult;
    try {
      r = await drainOnce(o.pool, o.driver, worker, batch);
    } catch (err) {
      o.log?.(`outbox worker: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(maxIdle, o.signal);
      continue;
    }
    o.onBatch?.(r);
    if (r.failed) o.log?.(`outbox worker: batch of ${r.failed} failed, retrying`);
    if (r.claimed === batch) {
      wait = idle;
      continue;
    }
    await sleep(r.claimed ? idle : wait, o.signal);
    wait = r.claimed ? idle : Math.min(wait * 2, maxIdle);
  }
}

export interface SyncStatus {
  asOf: string; // PG time up to which every change is in the graph
  lagMs: number; // age of the oldest unapplied event (0 = in sync)
  pending: number;
  lastProcessedAt: string | null;
}

/** Freshness for API responses (BR-11) and /api/health (F-45), from v_graph_sync_status. */
export async function syncStatus(pool: pg.Pool | pg.Client): Promise<SyncStatus> {
  const { rows } = await pool.query<{ pending: number; lag_ms: string; oldest_pending_at: Date | null; last_processed_at: Date | null; now: Date }>(
    'SELECT pending, lag_ms, oldest_pending_at, last_processed_at, clock_timestamp() AS now FROM v_graph_sync_status');
  const r = rows[0]!;
  return {
    asOf: (r.oldest_pending_at ?? r.now).toISOString(),
    lagMs: Number(r.lag_ms),
    pending: r.pending,
    lastProcessedAt: r.last_processed_at?.toISOString() ?? null,
  };
}
