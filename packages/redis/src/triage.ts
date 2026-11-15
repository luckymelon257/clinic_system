import { key, keys, type RedisCtx } from './client';

// F-40 / BR-14: emergency triage queue, Redis only (AOF everysec — at most ~1 s of arrivals lost on a crash).
// ZSET triage:queue, score = esi·1e13 + arrivalMs → ESI ascending, then arrival time (epoch ms < 1e13 until
// year 2286; max score 5.9e13 < 2^53, exact in a double). Members are zero-padded ids so equal scores
// (same ESI, same millisecond) pop in id order. ZPOPMIN is atomic → every entry is handed out exactly once.

export const TRIAGE_ENTRY_TTL_SECONDS = 24 * 3600;
const SCORE_ESI = 1e13;

export interface TriageInput {
  patientId: number | null;
  patientName: string;
  esi: number; // 1..5
  complaint: string;
}

export interface TriageEntry extends TriageInput {
  id: number;
  arrivedAt: string; // ISO
  position: number; // 1-based in queue; 0 once called
}

export const triageScore = (esi: number, arrivedMs: number) => esi * SCORE_ESI + arrivedMs;
const member = (id: number) => String(id).padStart(12, '0');

function toEntry(h: Record<string, string>, position: number): TriageEntry {
  return {
    id: Number(h.id),
    patientId: h.patientId ? Number(h.patientId) : null,
    patientName: h.patientName ?? '',
    esi: Number(h.esi),
    complaint: h.complaint ?? '',
    arrivedAt: new Date(Number(h.arrivedMs)).toISOString(),
    position,
  };
}

export async function triageAdd(ctx: RedisCtx, input: TriageInput, arrivedMs = Date.now()): Promise<TriageEntry> {
  if (!Number.isInteger(input.esi) || input.esi < 1 || input.esi > 5) throw new RangeError('ESI 1–5');
  const id = await ctx.client.incr(key(ctx, keys.triageSeq));
  const entryKey = key(ctx, keys.triageEntry(id));
  const results = await ctx.client
    .multi()
    .hSet(entryKey, {
      id,
      patientId: input.patientId ?? '',
      patientName: input.patientName,
      esi: input.esi,
      complaint: input.complaint,
      arrivedMs,
    })
    .expire(entryKey, TRIAGE_ENTRY_TTL_SECONDS)
    .zAdd(key(ctx, keys.triageQueue), { score: triageScore(input.esi, arrivedMs), value: member(id) })
    .zRank(key(ctx, keys.triageQueue), member(id))
    .exec();
  const rank = Number(results[3] ?? 0);
  return { id, ...input, arrivedAt: new Date(arrivedMs).toISOString(), position: rank + 1 };
}

/** Waiting entries in call order (ZRANGE + pipelined HGETALL). */
export async function triageList(ctx: RedisCtx, limit = 200): Promise<{ items: TriageEntry[]; total: number }> {
  const q = key(ctx, keys.triageQueue);
  const [ids, total] = await Promise.all([ctx.client.zRange(q, 0, limit - 1), ctx.client.zCard(q)]);
  if (!ids.length) return { items: [], total };
  const p = ctx.client.multi();
  for (const m of ids) p.hGetAll(key(ctx, keys.triageEntry(Number(m))));
  const hashes = (await p.execAsPipeline()) as unknown as Record<string, string>[];
  return { items: hashes.map((h, i) => toEntry(h, i + 1)), total };
}

/** Next patient (ZPOPMIN) or null when the queue is empty. Exactly-once under any number of consumers. */
export async function triageCallNext(ctx: RedisCtx): Promise<{ entry: TriageEntry | null; remaining: number }> {
  const q = key(ctx, keys.triageQueue);
  const popped = await ctx.client.zPopMin(q);
  if (!popped) return { entry: null, remaining: 0 };
  const id = Number(popped.value);
  const [h, remaining] = await Promise.all([ctx.client.hGetAll(key(ctx, keys.triageEntry(id))), ctx.client.zCard(q)]);
  return { entry: toEntry({ id: String(id), ...h }, 0), remaining };
}

export async function triageSize(ctx: RedisCtx): Promise<number> {
  return ctx.client.zCard(key(ctx, keys.triageQueue));
}
