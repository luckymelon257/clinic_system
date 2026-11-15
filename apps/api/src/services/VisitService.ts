import type { VisitCompleteInput, VisitCompleteResult } from '@clinic/contracts';
import { UnitOfWork } from '../db/UnitOfWork';
import { HttpError, notFound } from '../errors';
import { GraphService } from './GraphService';

export const VisitService = {
  /** Medical record + diagnoses + prescription + lab order + consultation invoice (issued) — all or nothing. */
  complete(userId: number, appointmentId: number, input: VisitCompleteInput): Promise<VisitCompleteResult> {
    return UnitOfWork.run(userId, async (uow) => {
      const appt = await uow.appointments.findById(appointmentId);
      if (!appt) throw notFound('Запис на прийом не знайдено');
      const doctor = await uow.doctors.findById(appt.doctorId);
      if (!doctor) throw notFound('Лікаря не знайдено');

      // BR-13: a `major` interaction (new items vs each other and vs what the patient takes now) does not block,
      // but the doctor must confirm it explicitly; checked before any write of this UoW.
      if (input.prescription) {
        const check = await GraphService.interactions({
          medicationIds: input.prescription.items.map((i) => i.medicationId),
          patientId: appt.patientId,
          at: null,
        });
        if (check.requiresAcknowledgement && input.interactionsAcknowledged !== true) {
          const pairs = check.interactions
            .filter((r) => r.severity === 'major')
            .map((r) => `${r.medicationAName} + ${r.medicationBName}`);
          throw new HttpError('BUSINESS_RULE',
            `Небезпечна взаємодія ліків (major): ${[...new Set(pairs)].join('; ')}. Підтвердіть призначення (interactionsAcknowledged)`);
        }
      }

      const medicalRecordId = await uow.medicalRecords.create({
        appointmentId,
        admissionId: null,
        complaints: input.complaints,
        examination: input.examination,
        conclusion: input.conclusion,
        recommendations: input.recommendations,
      });
      const diagnosisIds: number[] = [];
      for (const d of input.diagnoses) diagnosisIds.push(await uow.medicalRecords.addDiagnosis(medicalRecordId, d));

      const prescriptionId = input.prescription ? await uow.prescriptions.create(medicalRecordId, input.prescription) : null;
      const labOrderId = input.labOrder
        ? await uow.labOrders.create({ patientId: appt.patientId, doctorId: appt.doctorId, medicalRecordId, ...input.labOrder })
        : null;

      const invoiceId = await uow.invoices.create(appt.patientId, appointmentId, null);
      await uow.invoices.addItem(invoiceId, {
        itemType: 'consultation',
        description: `Консультація: ${doctor.specializationName}, ${doctor.fullName}`,
        quantity: 1,
        unitPrice: doctor.consultationFee,
      });
      await uow.invoices.issue(invoiceId);

      return { medicalRecordId, diagnosisIds, prescriptionId, labOrderId, invoiceId };
    });
  },
};
