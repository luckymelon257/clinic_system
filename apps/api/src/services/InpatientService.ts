import type { AdmitInput, DischargeResult } from '@clinic/contracts';
import { UnitOfWork } from '../db/UnitOfWork';

export const InpatientService = {
  /** Bed becomes occupied by trigger. */
  admit(userId: number, input: AdmitInput): Promise<number> {
    return UnitOfWork.run(userId, (uow) => uow.admissions.admit(input));
  },

  /** Old bed → available, new bed → occupied. */
  transfer(userId: number, admissionId: number, bedId: number): Promise<void> {
    return UnitOfWork.run(userId, (uow) => uow.admissions.transfer(admissionId, bedId));
  },

  /** Discharge + stay/lab/consultation invoice, issued — one transaction. */
  discharge(userId: number, admissionId: number, summary: string): Promise<DischargeResult> {
    return UnitOfWork.run(userId, async (uow) => ({ admissionId, invoiceId: await uow.admissions.discharge(admissionId, summary) }));
  },
};
