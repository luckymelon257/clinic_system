import type { LabOrderCreateInput, LabQueueItem, LabResult, LabResultInput, RouteQuery } from '@clinic/contracts';
import { BaseRepository, where } from '../db/BaseRepository';

export class LabOrderRepository extends BaseRepository {
  queue(q: RouteQuery<'labQueue'>) {
    const w = where({ priority: q.priority });
    return this.many<LabQueueItem>(`SELECT * FROM v_lab_queue ${w.sql}`, w.params); // view orders urgent first, then oldest
  }

  create(o: LabOrderCreateInput) {
    return this.callReturningId('sp_lab_order_create', [o.patientId, o.doctorId, o.medicalRecordId, o.priority, o.testCodes]);
  }

  resultsByOrder(orderId: number) {
    return this.many<LabResult>('SELECT * FROM v_lab_results WHERE order_id = $1 ORDER BY id', [orderId]);
  }

  resultsByPatient(patientId: number) {
    return this.many<LabResult>('SELECT * FROM v_lab_results WHERE patient_id = $1 ORDER BY recorded_at DESC, id DESC', [patientId]);
  }

  findResult(id: number) {
    return this.one<LabResult>('SELECT * FROM v_lab_results WHERE id = $1', [id]);
  }

  recordResult(orderId: number, r: LabResultInput) {
    return this.callReturningId('sp_lab_result_record', [orderId, r.testTypeId, r.valueNumeric, r.valueText]);
  }
}
