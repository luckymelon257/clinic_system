import type { WardType } from '@clinic/contracts';
import { BaseRepository } from '../db/BaseRepository';

export interface WardMeta {
  wardId: number;
  wardNumber: string;
  wardType: WardType;
  departmentId: number;
  departmentName: string;
  total: number;
}

export interface IcuBedRow {
  bedId: number;
  bedNumber: string;
  wardId: number;
  wardNumber: string;
  patientId: number | null;
  patientName: string | null;
}

export interface IcuAlertRow {
  streamId: string;
  bedId: number;
  patientId: number | null;
  patientName: string | null;
  violations: { sign: 'hr' | 'spo2' | 'sbp' | 'dbp' | 'rr' | 'temp'; value: number; rule: string }[];
  vitals: { hr: number; spo2: number; sbp: number; dbp: number; rr: number; temp: number; at: string };
  at: Date;
}

export interface AlertToRecord {
  streamId: string;
  bedId: number;
  patientId: number | null;
  violations: unknown;
  vitals: unknown;
  at: string;
}

/** Beds / ICU reads and the alert write for Lab 2 (views of migrations 008 / 011, sp_icu_alert_record). */
export class Lab2Repository extends BaseRepository {
  wards() {
    return this.many<WardMeta>(`
      SELECT ward_id, ward_number, ward_type, department_id, department_name, count(*)::int AS total
      FROM v_beds GROUP BY ward_id, ward_number, ward_type, department_id, department_name ORDER BY ward_id`);
  }

  async wardOfBed(bedId: number): Promise<number | null> {
    return (await this.one<{ wardId: number }>('SELECT ward_id FROM v_beds WHERE id = $1', [bedId]))?.wardId ?? null;
  }

  async bedOfAdmission(admissionId: number): Promise<number | null> {
    return (await this.one<{ bedId: number }>('SELECT bed_id FROM v_admissions WHERE id = $1', [admissionId]))?.bedId ?? null;
  }

  icuBeds() {
    return this.many<IcuBedRow>(
      'SELECT bed_id, bed_number, ward_id, ward_number, patient_id, patient_name FROM v_icu_beds ORDER BY ward_number, bed_number');
  }

  icuAlerts(limit: number, bedId?: number) {
    return this.many<IcuAlertRow>(
      `SELECT stream_id, bed_id, patient_id, patient_name, violations, vitals, at FROM v_icu_alerts
       WHERE ($2::int IS NULL OR bed_id = $2) ORDER BY at DESC, alert_id DESC LIMIT $1`,
      [limit, bedId ?? null],
    );
  }

  /** Idempotent on the stream id (ON CONFLICT DO NOTHING inside the procedure). */
  recordAlert(a: AlertToRecord) {
    return this.callReturningId('sp_icu_alert_record', [a.streamId, a.bedId, a.patientId, JSON.stringify(a.violations), JSON.stringify(a.vitals), a.at]);
  }
}
