import type { Doctor, FreeSlot, RouteQuery, ScheduleEntry } from '@clinic/contracts';
import { BaseRepository, where } from '../db/BaseRepository';

export class DoctorRepository extends BaseRepository {
  list(q: RouteQuery<'listDoctors'>) {
    const w = where({ department_id: q.departmentId, specialization_id: q.specializationId });
    return this.many<Doctor>(`SELECT * FROM v_doctors ${w.sql} ORDER BY full_name`, w.params);
  }

  findById(id: number) {
    return this.one<Doctor>('SELECT * FROM v_doctors WHERE id = $1', [id]);
  }

  schedule(doctorId: number) {
    return this.many<ScheduleEntry>('SELECT * FROM v_doctor_schedule WHERE doctor_id = $1 ORDER BY weekday, start_time', [doctorId]);
  }

  freeSlots(doctorId: number, date: string) {
    return this.many<FreeSlot>('SELECT * FROM fn_doctor_free_slots($1, $2)', [doctorId, date]);
  }
}
