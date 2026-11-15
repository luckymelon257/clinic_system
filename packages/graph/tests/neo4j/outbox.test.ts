import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDriver, readRows } from '../../neo4j/driver';
import { fullEtl } from '../../sync/etl';
import { drainOnce, syncStatus } from '../../sync/worker';
import { dumpGraph, loadGolden, PG_URL, testDriver } from './helpers';

// Outbox (D-23, D-32): writes in PG → worker → graph equal to a fresh full ETL; replay is idempotent;
// a Neo4j failure puts the batch back in the queue.
const driver = testDriver();
const pool = new pg.Pool({ connectionString: PG_URL, max: 3 });
let firstWriteEvent = 0;

async function drain(d = driver): Promise<number> {
  let total = 0;
  for (;;) {
    const r = await drainOnce(pool, d, 'test', 7); // small batches: several transactions, ordering across batches
    total += r.applied;
    if (r.claimed === 0) return total;
    if (r.failed) throw new Error('batch failed');
  }
}

beforeAll(async () => {
  await loadGolden();
  await fullEtl(PG_URL, driver);
  firstWriteEvent = Number((await pool.query<{ id: string }>('SELECT coalesce(max(id), 0) + 1 AS id FROM graph_outbox')).rows[0]!.id);
});
afterAll(async () => {
  await pool.end();
  await driver.close();
});

describe('outbox worker', () => {
  it('applies every kind of change so the graph equals a fresh full ETL', async () => {
    const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
    await q("CALL sp_admit_patient(12, 2, 1, 'тест', NULL)"); // new open stay: room + ward edges
    await q("INSERT INTO appointments (id, patient_id, doctor_id, starts_at, ends_at, status) VALUES (900, 5, 1, '2026-03-10T10:00Z', '2026-03-10T10:30Z', 'scheduled')");
    await q("UPDATE appointments SET status = 'cancelled' WHERE id = 900"); // edges of the source disappear
    await q("CALL sp_staff_shift_add(5, 1, '2026-03-07T10:00Z', '2026-03-07T12:00Z', NULL)");
    await q('CALL sp_transfer_patient(3, 5)'); // P3 moves R12/W1 → R21/W2 (whole stay, D-31)
    await q("UPDATE patients SET first_name = 'Нове' WHERE id = 1");
    await q("INSERT INTO staff (id, full_name, role, department_id) VALUES (900, 'Нова медсестра', 'nurse', 2)");
    await q("CALL sp_staff_shift_add(900, 3, '2026-03-11T09:00Z', '2026-03-11T10:00Z', NULL)");
    await q("INSERT INTO rooms (id, ward_id, room_number) VALUES (900, 3, 'R32')");
    await q('INSERT INTO medication_classes (medication_id, class_id) VALUES (7, 2)');
    await q('DELETE FROM medication_interactions WHERE medication_a = 5 AND medication_b = 6');
    await q("UPDATE drug_class_interactions SET severity = 'minor' WHERE class_a = 2 AND class_b = 2");
    await q("INSERT INTO prescription_items (prescription_id, medication_id, dosage, frequency, duration_days, quantity) VALUES (1, 3, '400 мг', '2 рази', 5, 10)");

    const pending = (await syncStatus(pool)).pending;
    expect(pending).toBeGreaterThanOrEqual(13);
    expect(await drain()).toBe(pending);
    expect((await syncStatus(pool)).pending).toBe(0);
    const viaOutbox = await dumpGraph(driver);

    await fullEtl(PG_URL, driver);
    const viaEtl = await dumpGraph(driver);
    expect(viaOutbox).toEqual(viaEtl);
    expect(viaEtl.filter((s) => s.startsWith('Person:Patient:12 -PRESENT') && s.includes('/9000000000000000/admission/'))).toHaveLength(2); // room + ward, open
    expect(viaEtl.some((s) => s.includes('/appointment/900/'))).toBe(false); // cancelled
    expect(viaEtl.some((s) => s.startsWith('Person:Patient:3 -PRESENT') && s.endsWith('Place:Room:3'))).toBe(true); // transferred
  });

  it('replaying already applied events leaves the graph unchanged (idempotent)', async () => {
    const before = await dumpGraph(driver);
    const { rowCount } = await pool.query(
      'UPDATE graph_outbox SET processed_at = NULL, claimed_at = NULL, claimed_by = NULL WHERE id >= $1', [firstWriteEvent]);
    expect(rowCount).toBeGreaterThanOrEqual(13);
    expect(await drain()).toBe(rowCount);
    expect(await dumpGraph(driver)).toEqual(before);
    // and replaying twice in a row as well
    await pool.query('UPDATE graph_outbox SET processed_at = NULL, claimed_at = NULL WHERE id >= $1', [firstWriteEvent]);
    await drain();
    expect(await dumpGraph(driver)).toEqual(before);
  });

  it('a Neo4j failure returns the batch to the queue with last_error; the next drain applies it', async () => {
    await pool.query("UPDATE patients SET first_name = 'Ще' WHERE id = 2");
    const dead = createDriver({ url: 'bolt://localhost:1', user: 'neo4j', password: 'x' }, 1, { maxTransactionRetryTime: 0 });
    try {
      const r = await drainOnce(pool, dead, 'dead', 10);
      expect(r).toMatchObject({ claimed: 1, applied: 0, failed: 1 });
    } finally {
      await dead.close();
    }
    const ev = (await pool.query<{ last_error: string | null; claimed_at: Date | null; processed_at: Date | null }>(
      'SELECT last_error, claimed_at, processed_at FROM graph_outbox ORDER BY id DESC LIMIT 1')).rows[0]!;
    expect(ev.last_error).toBeTruthy();
    expect(ev.claimed_at).toBeNull();
    expect(ev.processed_at).toBeNull();
    expect(await drain()).toBe(1);
    const [row] = await readRows<{ n: string }>(driver, 'MATCH (p:Patient {id: 2}) RETURN p.name AS n');
    expect(row!.n).toContain('Ще');
  });
});
