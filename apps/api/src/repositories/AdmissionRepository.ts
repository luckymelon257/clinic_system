import type { Admission, AdmitInput, Bed, Occupancy, RouteQuery } from '@clinic/contracts';
import { BaseRepository, where } from '../db/BaseRepository';

export class AdmissionRepository extends BaseRepository {
  beds(q: RouteQuery<'listBeds'>) {
    const w = where({ department_id: q.departmentId, status: q.status });
    return this.many<Bed>(`SELECT * FROM v_beds ${w.sql} ORDER BY department_name, ward_number, bed_number`, w.params);
  }

  findBed(id: number) {
    return this.one<Bed>('SELECT * FROM v_beds WHERE id = $1', [id]);
  }

  occupancy() {
    return this.many<Occupancy>('SELECT * FROM v_bed_occupancy ORDER BY department_name, ward_id NULLS FIRST');
  }

  current() {
    return this.many<Admission>('SELECT * FROM v_current_admissions ORDER BY admitted_at DESC, id DESC');
  }

  findById(id: number) {
    return this.one<Admission>('SELECT * FROM v_admissions WHERE id = $1', [id]);
  }

  admit(a: AdmitInput) {
    return this.callReturningId('sp_admit_patient', [a.patientId, a.bedId, a.doctorId, a.reason]);
  }

  transfer(admissionId: number, bedId: number) {
    return this.call('sp_transfer_patient', [admissionId, bedId]);
  }

  /** Discharge + sp_invoice_generate_for_admission (issued) → invoice id. */
  discharge(admissionId: number, summary: string) {
    return this.callReturningId('sp_discharge_patient', [admissionId, summary]);
  }
}
