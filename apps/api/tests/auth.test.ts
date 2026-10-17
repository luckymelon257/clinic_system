import { routes } from '@clinic/contracts';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { DEMO, fails, ok, password, type DemoRole } from './helpers';

describe('auth', () => {
  it.each(Object.keys(DEMO) as DemoRole[])('logs in as %s', async (role) => {
    const res = await ok('login', { body: { email: DEMO[role].toUpperCase(), password: password(role) } });
    expect(res.user.role).toBe(role);
    expect(res.user.email).toBe(DEMO[role]);
    if (role === 'doctor') expect(res.user.doctorId).toBeTypeOf('number');
    if (role === 'patient') expect(res.user.patientId).toBeTypeOf('number');
    const me = await ok('me', { token: res.token });
    expect(me).toEqual(res.user);
  });

  it('rejects a wrong password / unknown email with 401', async () => {
    await fails('login', { body: { email: DEMO.admin, password: 'nope' } }, 401, 'UNAUTHENTICATED');
    await fails('login', { body: { email: 'ghost@clinic.local', password: 'nope' } }, 401, 'UNAUTHENTICATED');
  });

  it('rejects inactive users at login and with an existing token', async () => {
    const email = `temp${Date.now()}@clinic.local`;
    const { id } = await ok('createUser', { as: 'admin', body: { email, password: 'secret123', role: 'cashier', fullName: 'Тимчасовий Касир' } });
    const { token } = await ok('login', { body: { email, password: 'secret123' } });
    await ok('setUserActive', { as: 'admin', params: { id }, body: { isActive: false } });
    await fails('login', { body: { email, password: 'secret123' } }, 401, 'UNAUTHENTICATED');
    await fails('me', { token }, 401, 'UNAUTHENTICATED');
    const users = await ok('listUsers', { as: 'admin', query: { limit: 200 } });
    expect(users.items.find((u) => u.id === id)?.isActive).toBe(false);
  });

  it('duplicate user email → 409', async () => {
    const e = await fails('createUser', { as: 'admin', body: { email: DEMO.doctor, password: 'secret123', role: 'doctor', fullName: 'Дубль' } }, 409);
    expect(e.code).toBe('CONFLICT');
  });
});

describe('RBAC', () => {
  it('no token → 401, bad token → 401', async () => {
    await fails('auditLog', {}, 401, 'UNAUTHENTICATED');
    await fails('auditLog', { token: 'garbage' }, 401, 'UNAUTHENTICATED');
  });

  it('role not in route.roles → 403', async () => {
    await fails('auditLog', { as: 'doctor' }, 403, 'FORBIDDEN');
    await fails('listInvoices', { as: 'lab_technician' }, 403, 'FORBIDDEN');
    await fails('searchPatients', { as: 'patient' }, 403, 'FORBIDDEN');
    await fails('createPatient', { as: 'doctor', body: {} }, 403, 'FORBIDDEN'); // RBAC before validation
  });

  it('allowed role → 200', async () => {
    await ok('auditLog', { as: 'admin' });
    await ok('listDepartments', { as: 'patient' });
  });
});

describe('http plumbing', () => {
  it('validation → 400 with issues', async () => {
    const e = await fails('createPatient', { as: 'registrar', body: { lastName: '', birthDate: '01.01.1990', sex: 'x' } }, 400);
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.issues?.map((i) => i.path)).toEqual(expect.arrayContaining(['lastName', 'firstName', 'birthDate', 'sex']));
    await fails('getPatient', { as: 'registrar', params: { id: 'abc' } }, 400, 'VALIDATION_ERROR');
  });

  it('malformed JSON → 400, unknown route → 404', async () => {
    const app = createApp();
    const bad = await request(app).post(routes.login.path).set('Content-Type', 'application/json').send('{"email":');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    const missing = await request(app).get('/api/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('serves OpenAPI generated from the contract + Swagger UI', async () => {
    const app = createApp();
    const spec = await request(app).get('/api/openapi.json');
    expect(spec.status).toBe(200);
    const ops = Object.values(spec.body.paths as Record<string, object>).flatMap((p) => Object.keys(p));
    expect(ops).toHaveLength(Object.keys(routes).length);
    expect(spec.body.paths['/api/patients/{id}'].put.requestBody).toBeDefined();
    const ui = await request(app).get('/api/docs/');
    expect(ui.status).toBe(200);
    expect(ui.text).toContain('swagger-ui');
  });

  it('CORS allows the web origin', async () => {
    const pre = await request(createApp()).options('/api/patients').set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'GET');
    expect(pre.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});
