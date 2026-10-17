import type { HistoryEvent, InsuranceCreateInput, Patient, PatientInput, PatientInsurance, RouteQuery } from '@clinic/contracts';
import { BaseRepository } from '../db/BaseRepository';

const fields = (p: PatientInput) => [
  p.lastName,
  p.firstName,
  p.middleName,
  p.birthDate,
  p.sex,
  p.phone,
  p.email,
  p.address,
  p.bloodType,
  p.emergencyContactName,
  p.emergencyContactPhone,
];

export class PatientRepository extends BaseRepository {
  search(q: RouteQuery<'searchPatients'>) {
    return this.many<Patient>('SELECT * FROM fn_search_patients($1, $2)', [q.q, q.limit]);
  }

  findById(id: number) {
    return this.one<Patient>('SELECT * FROM v_patients WHERE id = $1', [id]);
  }

  history(id: number) {
    return this.many<HistoryEvent>('SELECT * FROM fn_patient_history($1)', [id]);
  }

  insurances(patientId: number) {
    return this.many<PatientInsurance>('SELECT * FROM v_patient_insurances WHERE patient_id = $1 ORDER BY valid_from DESC, id DESC', [
      patientId,
    ]);
  }

  create(p: PatientInput) {
    return this.callReturningId('sp_patient_create', fields(p));
  }

  update(id: number, p: PatientInput) {
    return this.call('sp_patient_update', [id, ...fields(p)]);
  }

  addInsurance(patientId: number, i: InsuranceCreateInput) {
    return this.callReturningId('sp_patient_insurance_add', [
      patientId,
      i.companyId,
      i.policyNumber,
      i.coveragePercent,
      i.validFrom,
      i.validTo,
    ]);
  }
}
