import { reconcile, startAlertConsumer } from '@clinic/redis';
import { createApp } from './app';
import { pool } from './db/pool';
import { UnitOfWork } from './db/UnitOfWork';
import { redisCtx, resetNoSql } from './nosql';

const port = Number(process.env.PORT) || 4000;
const server = createApp().listen(port, () => console.log(`API on http://localhost:${port} (docs: /api/docs)`));

const RECONCILE_MS = Number(process.env.BED_RECONCILE_MS) || 60_000;
const RETRY_MS = 10_000;

// F-43: bed counters = v_beds at startup and every minute (heals increments lost while Redis was down).
async function reconcileBeds() {
  try {
    const diffs = await reconcile(await redisCtx(), pool);
    if (diffs.length) console.warn(`[beds] reconciled ${diffs.length} ward(s) with v_beds`);
  } catch (e) {
    console.warn(`[beds] reconcile skipped: ${(e as Error).message}`);
  }
}
void reconcileBeds();
const reconcileTimer = setInterval(() => void reconcileBeds(), RECONCILE_MS);

// F-44: the consumer group persists every critical alert in PG exactly once (idempotent on the stream id).
let stopConsumer: (() => Promise<void>) | null = null;
let consumerTimer: NodeJS.Timeout | null = null;
async function startConsumer() {
  try {
    stopConsumer = await startAlertConsumer(
      await redisCtx(),
      (r) =>
        UnitOfWork.run(null, (uow) =>
          uow.lab2.recordAlert({ streamId: r.streamId, bedId: r.bedId, patientId: r.patientId, violations: r.violations, vitals: r.vitals, at: r.vitals.at }),
        ).then(() => undefined),
      { consumer: `api-${process.pid}`, onError: (e) => console.warn(`[icu] alert consumer: ${e.message}`) },
    );
    console.log('[icu] alert consumer started');
  } catch (e) {
    console.warn(`[icu] alert consumer not started (${(e as Error).message}), retry in ${RETRY_MS / 1000}s`);
    consumerTimer = setTimeout(() => void startConsumer(), RETRY_MS);
  }
}
void startConsumer();

const stop = () => {
  clearInterval(reconcileTimer);
  if (consumerTimer) clearTimeout(consumerTimer);
  server.close(() => {
    void (async () => {
      await stopConsumer?.();
      await resetNoSql();
      await pool.end();
    })();
  });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
