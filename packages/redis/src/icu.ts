import { key, keys, type RedisClient, type RedisCtx } from './client';
import { ICU_INGEST_LUA } from './icu-script';

// F-44: ICU monitor. Readings → Lua (XADD + HSET latest + BR-17 check + PUBLISH / LPUSH alert).
// Two consumers of alerts, on purpose:
//   * pub/sub channel <prefix>:alerts:critical — instant fan-out to open SSE connections (fire-and-forget);
//   * consumer group on the stream — durable: the API persists every alert in PG (sp_icu_alert_record),
//     ACKs after commit, re-claims entries a crashed consumer left pending (XAUTOCLAIM).

export const STREAM_MAXLEN = 100_000;
export const LATEST_TTL_SECONDS = 300;
export const EVENTS_KEEP = 100;
export const ALERT_GROUP = 'alert-persister';

export type VitalSign = 'hr' | 'spo2' | 'sbp' | 'dbp' | 'rr' | 'temp';

export interface VitalsReading {
  bedId: number;
  patientId?: number | null;
  atMs?: number; // default now
  hr: number;
  spo2: number;
  sbp: number;
  dbp: number;
  rr: number;
  temp: number;
}

/** Contract-shaped (packages/contracts models: Vitals, VitalViolation, IcuAlert minus patientName). */
export interface Vitals {
  hr: number;
  spo2: number;
  sbp: number;
  dbp: number;
  rr: number;
  temp: number;
  at: string; // ISO
}
export interface VitalViolation {
  sign: VitalSign;
  value: number;
  rule: string;
}
export interface IcuAlert {
  id: string; // stream entry id
  bedId: number;
  patientId: number | null;
  violations: VitalViolation[];
  vitals: Vitals;
  at: string; // ISO
}

interface RawAlert {
  id: string;
  bedId: number;
  patientId?: number;
  violations: VitalViolation[];
  vitals: Omit<Vitals, 'at'> & { at: number };
  atMs: number;
}

export function parseAlert(json: string): IcuAlert {
  const r = JSON.parse(json) as RawAlert;
  return {
    id: r.id,
    bedId: r.bedId,
    patientId: r.patientId ?? null,
    // cjson encodes an empty table as {} — never happens for an alert, but keep the type honest
    violations: Array.isArray(r.violations) ? r.violations : [],
    vitals: { ...r.vitals, at: new Date(r.vitals.at).toISOString() },
    at: new Date(r.atMs).toISOString(),
  };
}

// ---------- script loading: SCRIPT LOAD once per client, EVALSHA, reload on NOSCRIPT (e.g. after a restart) ----------
const shas = new WeakMap<RedisClient, string>();

async function evalIngest(client: RedisClient, keysArr: string[], args: string[]): Promise<[string, string]> {
  let sha = shas.get(client);
  if (!sha) {
    sha = await client.scriptLoad(ICU_INGEST_LUA);
    shas.set(client, sha);
  }
  try {
    return (await client.evalSha(sha, { keys: keysArr, arguments: args })) as [string, string];
  } catch (e) {
    if (!String((e as Error).message).startsWith('NOSCRIPT')) throw e;
    shas.delete(client);
    return evalIngest(client, keysArr, args);
  }
}

/** One reading → stream + latest + BR-17 check (+ alert). Returns the stream id and the alert if any. */
export async function ingestVitals(ctx: RedisCtx, r: VitalsReading): Promise<{ streamId: string; alert: IcuAlert | null }> {
  const [streamId, json] = await evalIngest(
    ctx.client,
    [key(ctx, keys.icuVitals), key(ctx, keys.icuLatest(r.bedId)), key(ctx, keys.icuEvents)],
    [
      key(ctx, keys.alertsChannel), String(r.bedId), r.patientId ? String(r.patientId) : '', String(r.atMs ?? Date.now()),
      String(r.hr), String(r.spo2), String(r.sbp), String(r.dbp), String(r.rr), String(r.temp),
      String(STREAM_MAXLEN), String(LATEST_TTL_SECONDS), String(EVENTS_KEEP),
    ],
  );
  return { streamId, alert: json ? parseAlert(json) : null };
}

function toVitals(h: Record<string, string>): Vitals {
  return {
    hr: Number(h.hr), spo2: Number(h.spo2), sbp: Number(h.sbp), dbp: Number(h.dbp), rr: Number(h.rr), temp: Number(h.temp),
    at: new Date(Number(h.at)).toISOString(),
  };
}

/** Latest reading per bed (null = silent for > LATEST_TTL_SECONDS). One pipelined round trip. */
export async function latestVitals(ctx: RedisCtx, bedIds: readonly number[]): Promise<Map<number, (Vitals & { alerting: boolean }) | null>> {
  if (!bedIds.length) return new Map();
  const p = ctx.client.multi();
  for (const id of bedIds) p.hGetAll(key(ctx, keys.icuLatest(id)));
  const rows = (await p.execAsPipeline()) as unknown as Record<string, string>[];
  return new Map(bedIds.map((id, i) => {
    const h = rows[i];
    return [id, h && h.at ? { ...toVitals(h), alerting: h.alert === '1' } : null];
  }));
}

/** Last ≤ 100 alerts, newest first (LRANGE icu:events). */
export async function recentAlerts(ctx: RedisCtx, limit = EVENTS_KEEP): Promise<IcuAlert[]> {
  const raw = await ctx.client.lRange(key(ctx, keys.icuEvents), 0, Math.min(limit, EVENTS_KEEP) - 1);
  return raw.map(parseAlert);
}

/** Pub/sub needs its own connection (a subscribed client cannot run other commands). Returns unsubscribe. */
export async function subscribeAlerts(ctx: RedisCtx, onAlert: (a: IcuAlert) => void): Promise<() => Promise<void>> {
  const sub = ctx.client.duplicate();
  sub.on('error', () => {});
  await sub.connect();
  await sub.subscribe(key(ctx, keys.alertsChannel), (msg) => onAlert(parseAlert(msg)));
  return async () => {
    await sub.unsubscribe().catch(() => {});
    await sub.quit().catch(() => sub.destroy());
  };
}

export interface StreamReading {
  streamId: string;
  bedId: number;
  patientId: number | null;
  vitals: Vitals;
  alert: boolean;
  violations: VitalViolation[];
}

function toReading(id: string, f: Record<string, string>): StreamReading {
  return {
    streamId: id,
    bedId: Number(f.bed),
    patientId: f.patient ? Number(f.patient) : null,
    vitals: toVitals(f),
    alert: f.alert === '1',
    violations: f.violations ? (JSON.parse(f.violations) as VitalViolation[]) : [],
  };
}

/** Live tail of the stream for SSE (XREAD BLOCK on a dedicated connection). Starts at new entries ('$'). */
export async function tailVitals(ctx: RedisCtx, onReading: (r: StreamReading) => void, opts: { blockMs?: number } = {}): Promise<() => Promise<void>> {
  const c = ctx.client.duplicate();
  c.on('error', () => {});
  await c.connect();
  let stopped = false;
  let last = '$';
  const loop = (async () => {
    while (!stopped) {
      try {
        const res = (await c.xRead({ key: key(ctx, keys.icuVitals), id: last }, { BLOCK: opts.blockMs ?? 1_000, COUNT: 500 })) as
          { name: string; messages: { id: string; message: Record<string, string> }[] }[] | null;
        for (const s of res ?? []) {
          for (const m of s.messages) {
            last = m.id;
            onReading(toReading(m.id, m.message));
          }
        }
      } catch {
        if (!stopped) await new Promise((r) => setTimeout(r, 500));
      }
    }
  })();
  return async () => {
    stopped = true;
    await loop.catch(() => {});
    await c.quit().catch(() => c.destroy());
  };
}

// ---------- durable alert persistence: consumer group ----------
export async function ensureAlertGroup(ctx: RedisCtx, group = ALERT_GROUP): Promise<void> {
  try {
    await ctx.client.xGroupCreate(key(ctx, keys.icuVitals), group, '0', { MKSTREAM: true });
  } catch (e) {
    if (!String((e as Error).message).startsWith('BUSYGROUP')) throw e;
  }
}

export type AlertRecorder = (a: StreamReading) => Promise<void>;

/**
 * One consumer step: re-claim entries pending longer than `minIdleMs` (crashed consumer), then read new ones.
 * Alerts are passed to `record` (→ CALL sp_icu_alert_record, idempotent on stream id); an entry is XACKed only
 * after `record` resolved, so a failure leaves it pending for redelivery. Normal readings are ACKed right away.
 */
export async function processAlertBatch(
  ctx: RedisCtx,
  record: AlertRecorder,
  opts: { group?: string; consumer: string; count?: number; blockMs?: number; minIdleMs?: number; client?: RedisClient },
): Promise<{ read: number; recorded: number; failed: number }> {
  const c = opts.client ?? ctx.client;
  const group = opts.group ?? ALERT_GROUP;
  const stream = key(ctx, keys.icuVitals);
  const count = opts.count ?? 200;
  const claimed = await c.xAutoClaim(stream, group, opts.consumer, opts.minIdleMs ?? 30_000, '0-0', { COUNT: count });
  const msgs = claimed.messages.filter((m): m is { id: string; message: Record<string, string> } => m !== null);
  if (msgs.length < count) {
    const res = (await c.xReadGroup(group, opts.consumer, { key: stream, id: '>' }, { COUNT: count - msgs.length, BLOCK: opts.blockMs ?? 1_000 })) as
      { messages: { id: string; message: Record<string, string> }[] }[] | null;
    for (const s of res ?? []) msgs.push(...s.messages);
  }
  let recorded = 0;
  let failed = 0;
  const ack: string[] = [];
  for (const m of msgs) {
    const r = toReading(m.id, m.message);
    if (r.alert) {
      try {
        await record(r);
        recorded++;
      } catch {
        failed++;
        continue; // stays pending → XAUTOCLAIM later
      }
    }
    ack.push(m.id);
  }
  if (ack.length) await c.xAck(stream, group, ack);
  return { read: msgs.length, recorded, failed };
}

/** Background loop for the API process (dedicated blocking connection). Returns stop(). */
export async function startAlertConsumer(ctx: RedisCtx, record: AlertRecorder, opts: { consumer: string; group?: string; onError?: (e: Error) => void }): Promise<() => Promise<void>> {
  const c = ctx.client.duplicate();
  c.on('error', () => {});
  await c.connect();
  await ensureAlertGroup(ctx, opts.group);
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        await processAlertBatch(ctx, record, { ...opts, client: c });
      } catch (e) {
        opts.onError?.(e as Error);
        if (!stopped) await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  })();
  return async () => {
    stopped = true;
    await loop.catch(() => {});
    await c.quit().catch(() => c.destroy());
  };
}

/** PG side of the durable path: what the API passes as `record` (or uses directly). */
export function pgAlertRecorder(db: { query: (sql: string, params: unknown[]) => Promise<unknown> }): AlertRecorder {
  return async (r) => {
    await db.query('CALL sp_icu_alert_record($1, $2, $3, $4, $5, $6, NULL)', [
      r.streamId, r.bedId, r.patientId, JSON.stringify(r.violations), JSON.stringify(r.vitals), r.vitals.at,
    ]);
  };
}
