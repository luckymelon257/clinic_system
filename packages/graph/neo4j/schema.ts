import type { Driver } from 'neo4j-driver';

// Schema of the graph read-model (docs/06 §4). Created by the full ETL before loading.
//  - Uniqueness constraint per label id: every MERGE / MATCH by id (ETL relationship load, outbox worker,
//    start nodes of queries) is an index seek. Patients and staff share id numbers, so the constraints are on
//    :Patient / :Staff, never on :Person.
//  - PRESENT(src, srcId) index: the outbox worker replaces all edges of one source row by this key (D-32).
//  - TAKES(rxId) index: same for prescription items.
//  - No index on PRESENT(f, t): tracing expands from a node along its own relationships and filters f / t during
//    the expansion; a relationship range index only serves global scans by property, which no query does.
export const SCHEMA: readonly string[] = [
  'CREATE CONSTRAINT patient_id IF NOT EXISTS FOR (n:Patient) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT staff_id IF NOT EXISTS FOR (n:Staff) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT room_id IF NOT EXISTS FOR (n:Room) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT ward_id IF NOT EXISTS FOR (n:Ward) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT office_id IF NOT EXISTS FOR (n:Office) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT medication_id IF NOT EXISTS FOR (n:Medication) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT drug_class_id IF NOT EXISTS FOR (n:DrugClass) REQUIRE n.id IS UNIQUE',
  'CREATE INDEX present_src IF NOT EXISTS FOR ()-[r:PRESENT]-() ON (r.src, r.srcId)',
  'CREATE INDEX takes_rx IF NOT EXISTS FOR ()-[r:TAKES]-() ON (r.rxId)',
];

export async function ensureSchema(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    for (const q of SCHEMA) await session.run(q);
    await session.run('CALL db.awaitIndexes(300)');
  } finally {
    await session.close();
  }
}

/** Removes every relationship and node in batches (Community cannot drop / recreate the database). */
export async function wipeGraph(driver: Driver): Promise<void> {
  const session = driver.session();
  try {
    await session.run('MATCH ()-[r]->() CALL (r) { DELETE r } IN TRANSACTIONS OF 50000 ROWS');
    await session.run('MATCH (n) CALL (n) { DELETE n } IN TRANSACTIONS OF 50000 ROWS');
  } finally {
    await session.close();
  }
}
