import type { VisitCompleteInput, VisitCompleteResult } from '@clinic/contracts';
import { UnitOfWork } from '../db/UnitOfWork';
import { notFound } from '../errors';

export const VisitService = {
  /** Medical record + diagnoses + prescription + lab order + consultation invoice (issued) — all or nothing. */
  complete(userId: number, appointmentId: number, input: VisitCompleteInput): Promise<VisitCompleteResult> {
    return UnitOfWork.run(userId, async (uow) => {
      const appt = await uow.appointments.findById(appointmentId);
      if (!appt) throw notFound('Запис на прийом не знайдено');
      const doctor = await uow.doctors.findById(appt.doctorId);
      if (!doctor) throw notFound('Лікаря не знайдено');

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
