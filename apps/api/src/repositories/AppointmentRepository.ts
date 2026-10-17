import type { Appointment, AppointmentStatus, RouteQuery } from '@clinic/contracts';
import { BaseRepository, where, type Page } from '../db/BaseRepository';

export type AppointmentRow = Appointment & { departmentId: number };

export class AppointmentRepository extends BaseRepository {
  async list(q: RouteQuery<'listAppointments'>): Promise<Page<Appointment>> {
    const w = where({ doctor_id: q.doctorId, patient_id: q.patientId, status: q.status }, [
      ['starts_at >= $?::date AND starts_at < $?::date + 1', q.date],
    ]);
    const p = w.page(q.limit, q.offset);
    const total = await this.one<{ n: number }>(`SELECT count(*)::int AS n FROM v_appointments ${w.sql}`, w.params);
    const items = await this.many<Appointment>(`SELECT * FROM v_appointments ${w.sql} ORDER BY starts_at DESC, id ${p.limit}`, p.params);
    return { items, total: total?.n ?? 0 };
  }

  today(q: RouteQuery<'todayAppointments'>) {
    const w = where({ doctor_id: q.doctorId, department_id: q.departmentId });
    return this.many<Appointment>(`SELECT * FROM v_today_appointments ${w.sql} ORDER BY starts_at, id`, w.params);
  }

  findById(id: number) {
    return this.one<AppointmentRow>('SELECT * FROM v_appointments WHERE id = $1', [id]);
  }

  book(patientId: number, doctorId: number, startsAt: string, reason: string | null) {
    return this.callReturningId('sp_appointment_book', [patientId, doctorId, startsAt, reason]);
  }

  reschedule(id: number, startsAt: string) {
    return this.call('sp_appointment_reschedule', [id, startsAt]);
  }

  setStatus(id: number, status: AppointmentStatus) {
    return this.call('sp_appointment_set_status', [id, status]);
  }

  cancel(id: number, reason: string) {
    return this.call('sp_appointment_cancel', [id, reason]);
  }
}
