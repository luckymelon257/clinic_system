import type { AdmitInput, DischargeResult } from '@clinic/contracts';
import { applyBedChange } from '@clinic/redis';
import { UnitOfWork } from '../db/UnitOfWork';
import { afterCommit } from '../nosql';

// F-43: Redis bed counters follow every admit / transfer / discharge AFTER the PG transaction committed
// (HINCRBY in MULTI). A lost increment (crash, Redis down) is healed by the periodic reconcile with v_beds.
const counters = (fromWardId: number | null, toWardId: number | null) =>
  afterCommit('bed counters', (ctx) => applyBedChange(ctx, { fromWardId, toWardId }));

export const InpatientService = {
  /** Bed becomes occupied by trigger. */
  async admit(userId: number, input: AdmitInput): Promise<number> {
    const { id, ward } = await UnitOfWork.run(userId, async (uow) => ({
      id: await uow.admissions.admit(input),
      ward: await uow.lab2.wardOfBed(input.bedId),
    }));
    await counters(null, ward);
    return id;
  },

  /** Old bed → available, new bed → occupied. */
  async transfer(userId: number, admissionId: number, bedId: number): Promise<void> {
    const { from, to } = await UnitOfWork.run(userId, async (uow) => {
      const oldBed = await uow.lab2.bedOfAdmission(admissionId);
      await uow.admissions.transfer(admissionId, bedId);
      return { from: oldBed === null ? null : await uow.lab2.wardOfBed(oldBed), to: await uow.lab2.wardOfBed(bedId) };
    });
    await counters(from, to);
  },

  /** Discharge + stay/lab/consultation invoice, issued — one transaction. */
  async discharge(userId: number, admissionId: number, summary: string): Promise<DischargeResult> {
    const { result, ward } = await UnitOfWork.run(userId, async (uow) => {
      const bed = await uow.lab2.bedOfAdmission(admissionId);
      const invoiceId = await uow.admissions.discharge(admissionId, summary);
      return { result: { admissionId, invoiceId }, ward: bed === null ? null : await uow.lab2.wardOfBed(bed) };
    });
    await counters(ward, null);
    return result;
  },
};
