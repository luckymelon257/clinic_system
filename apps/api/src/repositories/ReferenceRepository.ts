import type { Department, Icd10Code, InsuranceCompany, LabTestType, Medication, RouteQuery, Specialization } from '@clinic/contracts';
import { BaseRepository } from '../db/BaseRepository';

export class ReferenceRepository extends BaseRepository {
  departments() {
    return this.many<Department>('SELECT * FROM v_departments ORDER BY name');
  }

  specializations() {
    return this.many<Specialization>('SELECT * FROM v_specializations ORDER BY name');
  }

  insuranceCompanies() {
    return this.many<InsuranceCompany>('SELECT * FROM v_insurance_companies ORDER BY name');
  }

  icd10(q: RouteQuery<'searchIcd10'>) {
    return this.many<Icd10Code>(
      "SELECT * FROM v_icd10_codes WHERE code ILIKE $1 || '%' OR title ILIKE '%' || $1 || '%' ORDER BY code LIMIT $2",
      [q.q, q.limit],
    );
  }

  medications(q: RouteQuery<'searchMedications'>) {
    return this.many<Medication>("SELECT * FROM v_medications WHERE name ILIKE '%' || $1 || '%' ORDER BY name LIMIT $2", [
      q.q,
      q.limit,
    ]);
  }

  labTestTypes() {
    return this.many<LabTestType>('SELECT * FROM v_lab_test_types ORDER BY code');
  }
}
