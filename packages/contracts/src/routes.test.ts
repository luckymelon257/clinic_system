import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildPath,
  canAccess,
  errorCodeForSqlState,
  ExposurePathQuery,
  InteractionCheckInput,
  routes,
  statusForCode,
  TraceContactsQuery,
  TriageAddInput,
  VisitCompleteInput,
} from './index';

describe('contracts', () => {
  it('route keys map to unique method+path', () => {
    const seen = new Set(Object.values(routes).map((r) => `${r.method} ${r.path}`));
    expect(seen.size).toBe(Object.keys(routes).length);
  });

  it('every input and output schema converts to JSON Schema (Swagger)', () => {
    for (const r of Object.values(routes)) {
      for (const s of [('params' in r ? r.params : undefined), ('query' in r ? r.query : undefined), ('body' in r ? r.body : undefined)]) {
        if (s) expect(() => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' })).not.toThrow();
      }
      expect(() => z.toJSONSchema(r.output, { unrepresentable: 'any' })).not.toThrow();
    }
  });

  it('builds paths and checks roles', () => {
    expect(buildPath(routes.getPatient.path, { id: 7 })).toBe('/api/patients/7');
    expect(canAccess(routes.auditLog, 'doctor')).toBe(false);
    expect(canAccess(routes.auditLog, 'admin')).toBe(true);
    expect(canAccess(routes.me, null)).toBe(false);
  });

  it('maps SQLSTATE to error codes', () => {
    expect(errorCodeForSqlState('23P01')).toBe('CONFLICT');
    expect(errorCodeForSqlState('23505')).toBe('CONFLICT');
    expect(errorCodeForSqlState('P0040')).toBe('BUSINESS_RULE');
    expect(errorCodeForSqlState('P0002')).toBe('NOT_FOUND');
    expect(errorCodeForSqlState('23503')).toBe('BUSINESS_RULE');
  });

  it('visit needs exactly one primary diagnosis', () => {
    const base = { conclusion: 'ok', diagnoses: [{ icd10Code: 'j06.9', kind: 'secondary' }] };
    expect(VisitCompleteInput.safeParse(base).success).toBe(false);
    const ok = VisitCompleteInput.parse({ ...base, diagnoses: [{ icd10Code: 'j06.9', kind: 'primary' }] });
    expect(ok.diagnoses[0]?.icd10Code).toBe('J06.9');
    expect(ok.prescription).toBeNull();
  });

  // ---------- Lab 2 ----------
  it('trace query: defaults, depth 1..5, window ordered and <= 90 days (BR-12)', () => {
    const base = { personId: '7', from: '2026-03-01T00:00:00Z', to: '2026-03-15T00:00:00Z' };
    const q = TraceContactsQuery.parse(base);
    expect(q).toMatchObject({ personKind: 'patient', personId: 7, depth: 2 });
    expect(TraceContactsQuery.safeParse({ ...base, depth: '6' }).success).toBe(false);
    expect(TraceContactsQuery.safeParse({ ...base, depth: '0' }).success).toBe(false);
    expect(TraceContactsQuery.safeParse({ ...base, to: base.from }).success).toBe(false);
    expect(TraceContactsQuery.safeParse({ ...base, to: '2026-05-30T00:00:01Z' }).success).toBe(false); // 90 d + 1 s
    expect(TraceContactsQuery.safeParse({ ...base, to: '2026-05-30T00:00:00Z' }).success).toBe(true); // exactly 90 d
  });

  it('exposure path needs two different persons', () => {
    const base = { aId: '1', bId: '1', from: '2026-03-01T00:00:00Z', to: '2026-03-15T00:00:00Z' };
    expect(ExposurePathQuery.safeParse(base).success).toBe(false);
    expect(ExposurePathQuery.parse({ ...base, bKind: 'staff' }).maxDepth).toBe(6);
  });

  it('interaction check and triage inputs', () => {
    expect(InteractionCheckInput.parse({ medicationIds: [1, 2] })).toEqual({ medicationIds: [1, 2], patientId: null, at: null });
    expect(InteractionCheckInput.safeParse({ medicationIds: [] }).success).toBe(false);
    expect(TriageAddInput.safeParse({ patientName: 'X', esi: 0, complaint: 'біль' }).success).toBe(false);
    expect(TriageAddInput.parse({ patientName: 'X', esi: 1, complaint: 'біль' }).patientId).toBeNull();
  });

  it('visit accepts optional interactionsAcknowledged (BR-13), old payloads still parse', () => {
    const base = { conclusion: 'ok', diagnoses: [{ icd10Code: 'J06.9', kind: 'primary' }] };
    expect(VisitCompleteInput.parse(base).interactionsAcknowledged).toBeUndefined();
    expect(VisitCompleteInput.parse({ ...base, interactionsAcknowledged: true }).interactionsAcknowledged).toBe(true);
  });

  it('degradation codes are 503; health is public', () => {
    expect(statusForCode.GRAPH_UNAVAILABLE).toBe(503);
    expect(statusForCode.QUEUE_UNAVAILABLE).toBe(503);
    expect(canAccess(routes.health, null)).toBe(true);
    expect(canAccess(routes.traceContacts, 'registrar')).toBe(false);
    expect(canAccess(routes.triageCallNext, 'registrar')).toBe(true);
  });
});
