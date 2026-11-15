import type { Scenario } from '../../src/types';
import { ingestVitals, type VitalsReading } from '../../../redis/src/icu';
import { clearPrefix, explainPg, INPUTS_NOTE, redisCtx } from './common';

const PG_SQL = 'CALL sp_icu_vitals_insert($1, $2, $3, $4, $5, $6, $7, $8, NULL)';

// Reading i: bed = icuBeds[i mod n]; every 100th reading is critical (HR 35), the rest normal with a small
// deterministic wobble — the same readings for both engines, ~1 % alerts as in a real ICU.
function reading(beds: number[], i: number): VitalsReading {
  return {
    bedId: beds[i % beds.length]!,
    atMs: Date.UTC(2030, 0, 1) + i * 1000,
    hr: i % 100 === 0 ? 35 : 70 + (i % 20),
    spo2: 95 + (i % 4),
    sbp: 115 + (i % 15),
    dbp: 70 + (i % 10),
    rr: 14 + (i % 5),
    temp: 36.6 + (i % 5) / 10,
  };
}

export const r4: Scenario = {
  id: 'R4',
  title: 'Інжест показників ICU: Lua-скрипт Redis vs CALL sp_icu_vitals_insert',
  engines: ['postgres', 'redis'],
  why: 'Монітори шлють показник щосекунди з кожного ліжка; запис має бути дешевим, а критичний алерт — миттєвим (≤ 2 с, F-44). ' +
    'Порівнюємо однакову роботу: зберегти показник + перевірити BR-17 + за порушення записати алерт і сповістити ' +
    '(Redis: XADD MAXLEN~ + HSET latest + PUBLISH + LPUSH одним Lua; PG: INSERT + fn_icu_violations + INSERT icu_alerts + pg_notify у ' +
    'транзакції з fsync при commit). ' + INPUTS_NOTE,
  expect: 'Redis у 3–10× швидший на c = 1 (пам\'ять + AOF everysec проти синхронного fsync WAL на кожен commit) і дає більшу пропускну ' +
    'здатність під 32 клієнтами; ціна — до 1 с даних при аварії (AOF everysec) і обрізаний потік (MAXLEN).',
  falsifiedIf: 'p50 PG ≤ p50 Redis на c = 1, або PG масштабується під 32 клієнтами краще за Redis (group commit WAL).',
  async variants(ctx) {
    const { rows } = await ctx.engines.pg.query<{ bed_id: number }>('SELECT bed_id FROM v_icu_beds ORDER BY bed_id');
    const beds = rows.map((x) => x.bed_id);
    if (!beds.length) throw new Error('R4: no ICU beds');
    const r = await redisCtx(ctx, 'r4');
    const args = (v: VitalsReading) => [v.bedId, new Date(v.atMs!).toISOString(), v.hr, v.spo2, v.sbp, v.dbp, v.rr, v.temp];
    return [{
      id: 'ingest',
      label: `1 показник, ${beds.length} ліжок ICU, 1 % критичних`,
      params: { icuBeds: beds.length, criticalEvery: 100 },
      ops: [
        {
          engine: 'postgres',
          setup: async () => {
            await ctx.engines.pg.query("DELETE FROM icu_alerts WHERE stream_id LIKE 'pg:%'");
            await ctx.engines.pg.query('TRUNCATE icu_vitals_pg RESTART IDENTITY');
          },
          run: (i: number) => ctx.engines.pg.query(PG_SQL, args(reading(beds, i))),
          explain: () => explainPg(ctx, PG_SQL, args(reading(beds, 0))),
        },
        {
          engine: 'redis',
          setup: () => clearPrefix(r),
          run: (i: number) => ingestVitals(r, reading(beds, i)),
          teardown: () => clearPrefix(r),
        },
      ],
    }];
  },
};
