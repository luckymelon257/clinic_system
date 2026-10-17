import type { DiagnosisInput, MedicalRecord, RouteQuery } from '@clinic/contracts';
import { BaseRepository, where, type Page } from '../db/BaseRepository';

export type RecordInput = {
  appointmentId: number | null;
  admissionId: number | null;
  complaints: string | null;
  examination: string | null;
  conclusion: string;
  recommendations: string | null;
};

export class MedicalRecordRepository extends BaseRepository {
  async list(q: RouteQuery<'listMedicalRecords'>): Promise<Page<MedicalRecord>> {
    const w = where({ patient_id: q.patientId });
    const p = w.page(q.limit, q.offset);
    const total = await this.one<{ n: number }>(`SELECT count(*)::int AS n FROM v_medical_records ${w.sql}`, w.params);
    const items = await this.many<MedicalRecord>(`SELECT * FROM v_medical_records ${w.sql} ORDER BY created_at DESC, id DESC ${p.limit}`, p.params);
    return { items, total: total?.n ?? 0 };
  }

  findById(id: number) {
    return this.one<MedicalRecord>('SELECT * FROM v_medical_records WHERE id = $1', [id]);
  }

  create(r: RecordInput) {
    return this.callReturningId('sp_medical_record_create', [
      r.appointmentId,
      r.admissionId,
      r.complaints,
      r.examination,
      r.conclusion,
      r.recommendations,
    ]);
  }

  addDiagnosis(recordId: number, d: DiagnosisInput) {
    return this.callReturningId('sp_diagnosis_add', [recordId, d.icd10Code, d.kind, d.notes]);
  }
}
