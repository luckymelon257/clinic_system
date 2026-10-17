import { describe, expect, it } from 'vitest';
import { violations } from '../scripts/check-sql-access';

describe('check:sql-access', () => {
  it('allows views, functions and procedures', () => {
    const ok = [
      "this.one('SELECT * FROM v_patients WHERE id = $1')",
      "this.many(`SELECT * FROM fn_doctor_free_slots($1, $2)`)",
      "this.many('SELECT * FROM mv_monthly_revenue')",
      "this.call(`CALL sp_patient_update(${x})`)",
      "// SELECT * FROM patients  (comment, ignored)",
      "import pg from 'pg';",
    ];
    for (const src of ok) expect(violations(src), src).toEqual([]);
  });

  it('flags direct table access', () => {
    expect(violations("q('INSERT INTO patients VALUES (1)')")).toHaveLength(1);
    expect(violations('q("update patients set x = 1")')).toHaveLength(1);
    expect(violations("q(`DELETE FROM users WHERE id = 1`)")).toHaveLength(2); // DELETE FROM + FROM users
    expect(violations("q('SELECT * FROM patients')")).toEqual(['FROM patients']);
    expect(violations("q('SELECT * FROM v_a JOIN doctors d ON true')")).toEqual(['JOIN doctors']);
    expect(violations('q(`SELECT * FROM ${table}`)')).toHaveLength(1); // unverifiable
  });
});
