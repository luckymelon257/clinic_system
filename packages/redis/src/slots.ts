import { key, keys, type RedisCtx } from './client';

// F-41 / BR-18: cache-aside for fn_doctor_free_slots. The cache is NEVER authoritative — booking always goes
// through PG (BR-1 EXCLUDE); the caller deletes the key AFTER the booking transaction commits, so a reader can
// at worst see a slot that was just taken (and gets 409 from PG), never miss a free one for longer than the TTL.

export const SLOT_TTL_SECONDS = 60;

/** Cached slots or null on miss. Throws if Redis is down — the caller falls back to PG. */
export async function getSlots<T>(ctx: RedisCtx, doctorId: number, date: string): Promise<T[] | null> {
  const raw = await ctx.client.get(key(ctx, keys.slots(doctorId, date)));
  return raw === null ? null : (JSON.parse(raw) as T[]);
}

export async function setSlots<T>(ctx: RedisCtx, doctorId: number, date: string, slots: readonly T[], ttlSeconds = SLOT_TTL_SECONDS): Promise<void> {
  await ctx.client.set(key(ctx, keys.slots(doctorId, date)), JSON.stringify(slots), { expiration: { type: 'EX', value: ttlSeconds } });
}

/** Call after the UoW that booked / cancelled / rescheduled has committed. */
export async function invalidateSlots(ctx: RedisCtx, doctorId: number, date: string): Promise<void> {
  await ctx.client.del(key(ctx, keys.slots(doctorId, date)));
}

/** Cache-aside in one call: hit → cached; miss → load() from PG and fill; Redis down → load() only. */
export async function cachedSlots<T>(ctx: RedisCtx | null, doctorId: number, date: string, load: () => Promise<T[]>): Promise<{ slots: T[]; source: 'redis' | 'postgres' }> {
  if (ctx) {
    try {
      const hit = await getSlots<T>(ctx, doctorId, date);
      if (hit) return { slots: hit, source: 'redis' };
    } catch {
      return { slots: await load(), source: 'postgres' };
    }
  }
  const slots = await load();
  if (ctx) await setSlots(ctx, doctorId, date, slots).catch(() => {});
  return { slots, source: 'postgres' };
}
