import type { Prescription, PrescriptionInput } from '@clinic/contracts';
import { BaseRepository } from '../db/BaseRepository';

export class PrescriptionRepository extends BaseRepository {
  listByPatient(patientId: number) {
    return this.many<Prescription>('SELECT * FROM v_prescriptions WHERE patient_id = $1 ORDER BY issued_at DESC, id DESC', [patientId]);
  }

  create(recordId: number, p: PrescriptionInput) {
    return this.callReturningId('sp_prescription_create', [recordId, p.validUntil, JSON.stringify(p.items)]);
  }
}
