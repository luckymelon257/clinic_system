import type { RegistrationInput, RegistrationResult } from '@clinic/contracts';
import { UnitOfWork } from '../db/UnitOfWork';

export const RegistrationService = {
  /** Patient + optional insurance + optional first appointment — all or nothing. */
  register(userId: number, input: RegistrationInput): Promise<RegistrationResult> {
    return UnitOfWork.run(userId, async (uow) => {
      const patientId = await uow.patients.create(input.patient);
      const insuranceId = input.insurance ? await uow.patients.addInsurance(patientId, input.insurance) : null;
      const a = input.appointment;
      const appointmentId = a ? await uow.appointments.book(patientId, a.doctorId, a.startsAt, a.reason) : null;
      return { patientId, insuranceId, appointmentId };
    });
  },
};
