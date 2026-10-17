import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { fails, newPatient, ok, patientBody } from './helpers';

describe('audit stamps', () => {
  it('updated_by = JWT user after PUT /api/patients/:id (v_patients + v_audit_log)', async () => {
    const id = await newPatient();
    const registrar = await ok('me', { as: 'registrar' });
    const updated = await ok('updatePatient', {
      as: 'registrar',
      params: { id },
      body: { ...patientBody('Оновлений'), address: 'м. Львів', bloodType: 'B+' },
    });
    expect(updated).toMatchObject({ lastName: 'Оновлений', address: 'м. Львів', bloodType: 'B+', updatedBy: registrar.id });
    expect(updated.updatedByEmail).toBe('registrar@clinic.local');

    const { rows } = await pool.query('SELECT updated_by FROM v_patients WHERE id = $1', [id]);
    expect(rows[0].updated_by).toBe(registrar.id);

    const log = await ok('auditLog', { as: 'admin', query: { tableName: 'patients', recordId: id, operation: 'UPDATE' } });
    expect(log.total).toBe(1);
    expect(log.items[0]).toMatchObject({ changedBy: registrar.id, changedByEmail: 'registrar@clinic.local' });
    expect(log.items[0]!.changedFields).toEqual(expect.arrayContaining(['last_name', 'address', 'blood_type']));
    expect(log.items[0]!.newData).toMatchObject({ last_name: 'Оновлений' }); // raw to_jsonb(row), snake_case
  });

  it('PUT on a missing patient → 404', async () => {
    await fails('updatePatient', { as: 'registrar', params: { id: 999999 }, body: patientBody() }, 404, 'NOT_FOUND');
  });
});

describe('soft delete + restore', () => {
  it('DELETE → 404 → listed as deleted → restore → visible, audited', async () => {
    const id = await newPatient();
    const admin = await ok('me', { as: 'admin' });
    const registrar = await ok('me', { as: 'registrar' });

    await ok('deletePatient', { as: 'registrar', params: { id } });
    await fails('getPatient', { as: 'registrar', params: { id } }, 404, 'NOT_FOUND');
    const deleted = await ok('deletedRecords', { as: 'admin', query: { tableName: 'patients' } });
    expect(deleted.find((d) => d.recordId === id)).toMatchObject({ tableName: 'patients', deletedBy: registrar.id });

    // non-admin cannot restore (route RBAC)
    await fails('restore', { as: 'registrar', params: { table: 'patients', id } }, 403, 'FORBIDDEN');
    await ok('restore', { as: 'admin', params: { table: 'patients', id } });
    await ok('getPatient', { as: 'registrar', params: { id } });
    expect((await ok('deletedRecords', { as: 'admin', query: { tableName: 'patients' } })).some((d) => d.recordId === id)).toBe(false);

    const ops = (await ok('auditLog', { as: 'admin', query: { tableName: 'patients', recordId: id } })).items.map((e) => [e.operation, e.changedBy]);
    expect(ops).toEqual(expect.arrayContaining([['SOFT_DELETE', registrar.id], ['RESTORE', admin.id]]));

    // generic admin soft delete
    await ok('softDelete', { as: 'admin', params: { table: 'patients', id } });
    await fails('getPatient', { as: 'admin', params: { id } }, 404);
    await fails('softDelete', { as: 'admin', params: { table: 'patients', id } }, 404, 'NOT_FOUND');
    await fails('softDelete', { as: 'admin', params: { table: 'appointments', id } }, 400, 'VALIDATION_ERROR');
  });
});
