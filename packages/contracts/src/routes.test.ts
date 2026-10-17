import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildPath, canAccess, errorCodeForSqlState, routes, VisitCompleteInput } from './index';

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
});
