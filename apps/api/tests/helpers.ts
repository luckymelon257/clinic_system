import { buildPath, ErrorEnvelope, routes, type ErrorCode, type RouteDef, type RouteName, type RouteOutput } from '@clinic/contracts';
import request from 'supertest';
import { afterAll, expect } from 'vitest';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { resetNoSql } from '../src/nosql';

export { app };

afterAll(async () => {
  await resetNoSql();
  await pool.end();
});

const app = createApp();

export const DEMO = {
  admin: 'admin@clinic.local',
  registrar: 'registrar@clinic.local',
  doctor: 'doctor@clinic.local',
  lab_technician: 'lab@clinic.local',
  cashier: 'cashier@clinic.local',
  patient: 'patient@clinic.local',
} as const;
export type DemoRole = keyof typeof DEMO;
export const password = (role: DemoRole) => `${role === 'lab_technician' ? 'lab' : role}123`;

const tokens = new Map<DemoRole, string>();
export async function token(role: DemoRole): Promise<string> {
  if (!tokens.has(role)) {
    const res = await request(app).post(routes.login.path).send({ email: DEMO[role], password: password(role) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    tokens.set(role, routes.login.output.parse(res.body).token);
  }
  return tokens.get(role)!;
}

type Opts = {
  as?: DemoRole | null;
  token?: string;
  params?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

/** Raw supertest response for a contract route. */
export async function hit(name: RouteName, o: Opts = {}) {
  const r = routes[name];
  const t = o.token ?? (o.as ? await token(o.as) : undefined);
  const method = r.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  let req = request(app)[method](buildPath(r.path, o.params));
  if (o.query) req = req.query(Object.fromEntries(Object.entries(o.query).filter(([, v]) => v !== undefined)));
  if (t) req = req.set('Authorization', `Bearer ${t}`);
  if (o.body !== undefined) req = req.send(o.body as object);
  return req;
}

/** Expects the contract success status and returns the body parsed with the route's output schema. */
export async function ok<N extends RouteName>(name: N, o: Opts = {}): Promise<RouteOutput<N>> {
  const res = await hit(name, o);
  const r: RouteDef = routes[name];
  expect(res.status, JSON.stringify(res.body)).toBe(r.status ?? 200);
  return r.output.parse(res.body) as RouteOutput<N>;
}

/** Expects an error status and a valid ErrorEnvelope. */
export async function fails(name: RouteName, o: Opts, status: number, code?: ErrorCode) {
  const res = await hit(name, o);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  const { error } = ErrorEnvelope.parse(res.body);
  if (code) expect(error.code).toBe(code);
  return error;
}

/** Row count of a view (tests read views only, like the app). */
export async function count(view: `v_${string}`, where = 'TRUE', params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${view} WHERE ${where}`, params);
  return rows[0].n;
}

/** 'YYYY-MM-DD' n days from today. */
export const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export async function demoDoctorId() {
  return (await ok('me', { as: 'doctor' })).doctorId!;
}
export async function demoPatientId() {
  return (await ok('me', { as: 'patient' })).patientId!;
}

/** n-th free slot of the demo doctor (works every day 08:00–20:00) `daysAhead` days from now. */
export async function freeSlot(doctorId: number, daysAhead = 3, n = 0) {
  const slots = await ok('freeSlots', { as: 'registrar', params: { id: doctorId }, query: { date: day(daysAhead) } });
  expect(slots.length).toBeGreaterThan(n);
  return slots[n]!.slotStart;
}

let seq = 0;
export const patientBody = (lastName = `Тестов${Date.now() % 100000}${seq++}`) => ({
  lastName,
  firstName: 'Іван',
  birthDate: '1990-05-01',
  sex: 'male',
  phone: '+380 50 123 45 67',
});

export async function newPatient(lastName?: string) {
  return (await ok('createPatient', { as: 'registrar', body: patientBody(lastName) })).id;
}
