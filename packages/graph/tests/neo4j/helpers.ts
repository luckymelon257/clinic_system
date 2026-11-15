import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { databaseUrl, ensureDatabase, migrate, withDatabase } from '@clinic/db';
import type { Driver } from 'neo4j-driver';
import pg from 'pg';
import { createDriver, readRows } from '../../neo4j/driver';

// graph-neo4j tests: PG clinic_neo_test + the disposable Neo4j instance (neo4j-test, bolt 7689). Never the main one.
export const PG_URL = process.env.TEST_NEO_DATABASE_URL || withDatabase(databaseUrl(), 'clinic_neo_test');
export const NEO4J_URL = process.env.TEST_NEO4J_URL || 'bolt://localhost:7689';

const golden = (f: string) => fileURLToPath(new URL(`../../fixtures/golden/${f}`, import.meta.url));
export const expected = JSON.parse(readFileSync(golden('expected.json'), 'utf8')) as Expected;

export interface PersonRef { kind: 'patient' | 'staff'; id: number }
export interface Expected {
  window: { from: string; to: string };
  counts: { node: Record<string, number>; rel: Record<string, number> };
  trace: { name: string; index: PersonRef; from: string; to: string; depth: number; expected: (PersonRef & { hops: number })[] }[];
  path: { name: string; a: PersonRef; b: PersonRef; from: string; to: string; maxDepth: number; length: number | null }[];
  interactions: { name: string; medicationIds: number[]; patientId: number | null; at: string | null;
    expected: { a: number; b: number; severity: string; via: string; classA: number | null; classB: number | null }[] }[];
}

export const testDriver = (): Driver => createDriver({ url: NEO4J_URL, user: process.env.NEO4J_USER || 'neo4j', password: process.env.NEO4J_PASSWORD || 'clinicneo4j' }, 20);

/** Empty schema → migrations only (no seeds) → golden fixture. */
export async function loadGolden(): Promise<void> {
  await ensureDatabase(PG_URL);
  const c = new pg.Client({ connectionString: PG_URL });
  await c.connect();
  try {
    await c.query('DROP SCHEMA IF EXISTS public CASCADE');
    await c.query('CREATE SCHEMA public');
  } finally {
    await c.end();
  }
  await migrate(PG_URL);
  const f = new pg.Client({ connectionString: PG_URL });
  await f.connect();
  try {
    await f.query(readFileSync(golden('fixture.sql'), 'utf8'));
  } finally {
    await f.end();
  }
}

/**
 * Canonical text dump of the whole graph (every node id per label, every relationship with its properties):
 * two graphs are equal iff their dumps are equal. Names are excluded — they are display data, and the
 * outbox payload of an office carries no name.
 */
const LABELS = "['Person', 'Patient', 'Staff', 'Place', 'Room', 'Ward', 'Office', 'Medication', 'DrugClass']";
const key = (v: string) => `reduce(s = '', l IN [l IN ${LABELS} WHERE l IN labels(${v})] | s + l + ':') + toString(${v}.id)`;

export async function dumpGraph(driver: Driver): Promise<string[]> {
  const n = await readRows<{ s: string }>(driver, `MATCH (n) RETURN ${key('n')} AS s`);
  const r = await readRows<{ s: string }>(driver, `
    MATCH (a)-[r]->(b)
    RETURN ${key('a')} + ' -' + type(r) + ' ' +
           coalesce(toString(r.f), '') + '/' + coalesce(toString(r.t), '') + '/' + coalesce(r.src, '') + '/' +
           coalesce(toString(r.srcId), '') + '/' + coalesce(toString(r.rxId), '') + '/' + coalesce(r.severity, '') +
           '-> ' + ${key('b')} AS s`);
  return [...n.map((x) => x.s), ...r.map((x) => x.s)].sort();
}
