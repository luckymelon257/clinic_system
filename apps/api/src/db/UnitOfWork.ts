import type pg from 'pg';
import { AdmissionRepository } from '../repositories/AdmissionRepository';
import { AppointmentRepository } from '../repositories/AppointmentRepository';
import { AuditRepository } from '../repositories/AuditRepository';
import { DoctorRepository } from '../repositories/DoctorRepository';
import { InvoiceRepository } from '../repositories/InvoiceRepository';
import { LabOrderRepository } from '../repositories/LabOrderRepository';
import { MedicalRecordRepository } from '../repositories/MedicalRecordRepository';
import { PatientRepository } from '../repositories/PatientRepository';
import { PrescriptionRepository } from '../repositories/PrescriptionRepository';
import { ReferenceRepository } from '../repositories/ReferenceRepository';
import { UserRepository } from '../repositories/UserRepository';
import { pool, type Db } from './pool';

/** Lazily created repositories that all share one connection (pool for reads, a tx client inside a UoW). */
export class Repositories {
  private cache = new Map<string, unknown>();
  constructor(protected readonly db: Db) {}

  private repo<T>(name: string, Ctor: new (db: Db) => T): T {
    if (!this.cache.has(name)) this.cache.set(name, new Ctor(this.db));
    return this.cache.get(name) as T;
  }

  get users() { return this.repo('users', UserRepository); }
  get reference() { return this.repo('reference', ReferenceRepository); }
  get patients() { return this.repo('patients', PatientRepository); }
  get doctors() { return this.repo('doctors', DoctorRepository); }
  get appointments() { return this.repo('appointments', AppointmentRepository); }
  get medicalRecords() { return this.repo('medicalRecords', MedicalRecordRepository); }
  get prescriptions() { return this.repo('prescriptions', PrescriptionRepository); }
  get labOrders() { return this.repo('labOrders', LabOrderRepository); }
  get admissions() { return this.repo('admissions', AdmissionRepository); }
  get invoices() { return this.repo('invoices', InvoiceRepository); }
  get audit() { return this.repo('audit', AuditRepository); }
}

/** Read-only access outside a transaction. Never call procedures through it — writes go through UnitOfWork.run. */
export const reads = new Repositories(pool);

/** One client, one transaction, `app.current_user_id` set for the audit triggers. */
export class UnitOfWork extends Repositories {
  private constructor(client: pg.PoolClient) {
    super(client);
  }

  static async run<T>(userId: number | null, work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId == null ? '' : String(userId)]);
      const result = await work(new UnitOfWork(client));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}
