import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { databaseUrl, migrate, withDatabase } from '@clinic/db';
import pg from 'pg';

export const GRAPH_TEST_URL = process.env.GRAPH_TEST_DATABASE_URL || withDatabase(databaseUrl(), 'clinic_graph_test');
const fixtureDir = fileURLToPath(new URL('../../fixtures/golden/', import.meta.url));

/** CREATE DATABASE if missing → DROP SCHEMA → migrate (no seeds) → golden fixture. */
export async function loadGolden(url = GRAPH_TEST_URL): Promise<void> {
  const admin = new pg.Client({ connectionString: withDatabase(url, 'postgres') });
  await admin.connect();
  const name = new URL(url).pathname.slice(1);
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public');
  } finally {
    await c.end();
  }
  await migrate(url);
  const f = new pg.Client({ connectionString: url });
  await f.connect();
  try {
    await f.query(readFileSync(`${fixtureDir}fixture.sql`, 'utf8'));
  } finally {
    await f.end();
  }
}

export interface Person {
  kind: 'patient' | 'staff';
  id: number;
}

export interface Expected {
  counts: { node: Record<string, number>; rel: Record<string, number> };
  trace: { name: string; index: Person; from: string; to: string; depth: number; expected: (Person & { hops: number })[] }[];
  path: { name: string; a: Person; b: Person; from: string; to: string; maxDepth: number; length: number | null }[];
  interactions: {
    name: string;
    medicationIds: number[];
    patientId: number | null;
    at: string | null;
    expected: { a: number; b: number; severity: string; via: string; classA: number | null; classB: number | null }[];
  }[];
}

export const expected = JSON.parse(readFileSync(`${fixtureDir}expected.json`, 'utf8')) as Expected;
