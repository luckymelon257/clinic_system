import { routes, type IcuStreamEvent } from '@clinic/contracts';
import { subscribeAlerts, tailVitals } from '@clinic/redis';
import type { Request, Response } from 'express';
import { authenticate } from './auth';
import { reads } from './db/UnitOfWork';
import { HttpError } from './errors';
import { redisCtx } from './nosql';

export const PING_MS = Number(process.env.SSE_PING_MS) || 15_000;

/**
 * GET /api/icu/stream — text/event-stream (F-44). Auth via the Authorization header like every other route
 * (the web client uses fetch streaming, so the token never appears in a URL). Each `data:` line is one
 * contracts `IcuStreamEvent`: `vitals` from XREAD on icu:vitals, `alert` from pub/sub alerts:critical, `ping`.
 */
export async function icuStream(req: Request, res: Response): Promise<void> {
  await authenticate(req, routes.icuStream);
  let ctx;
  let stopVitals: (() => Promise<void>) | null = null;
  let stopAlerts: (() => Promise<void>) | null = null;
  try {
    ctx = await redisCtx();
    if (!ctx.client.isReady) throw new Error('Redis not connected');
    stopVitals = await tailVitals(ctx, (r) => send({ type: 'vitals', bedId: r.bedId, vitals: r.vitals }), { blockMs: 1_000 });
    stopAlerts = await subscribeAlerts(ctx, (a) => {
      void patientName(a.bedId, a.patientId).then((patientName) => send({ type: 'alert', alert: { ...a, patientName } }));
    });
  } catch {
    await stopVitals?.();
    throw new HttpError('QUEUE_UNAVAILABLE', 'Потік показників ICU (Redis) недоступний');
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const names = new Map<number, string | null>();
  async function patientName(bedId: number, patientId: number | null): Promise<string | null> {
    if (!names.has(bedId)) names.set(bedId, (await reads.lab2.icuBeds()).find((b) => b.bedId === bedId)?.patientName ?? null);
    return patientId === null && !names.get(bedId) ? null : (names.get(bedId) ?? null);
  }
  function send(e: IcuStreamEvent) {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
  }

  send({ type: 'ping', at: new Date().toISOString() });
  const timer = setInterval(() => send({ type: 'ping', at: new Date().toISOString() }), PING_MS);
  req.on('close', () => {
    clearInterval(timer);
    void stopVitals?.();
    void stopAlerts?.();
  });
}
