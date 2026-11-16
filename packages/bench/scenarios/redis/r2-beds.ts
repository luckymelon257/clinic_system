import type { Scenario } from '../../src/types';
import { countsFromPg, readCounts, reconcile } from '@clinic/redis';
import { clearPrefix, INPUTS_NOTE, redisCtx } from './common';

const PG_SQL = `SELECT ward_id, (count(*) FILTER (WHERE status = 'available'))::int AS free,
  (count(*) FILTER (WHERE status = 'occupied'))::int AS occupied FROM v_beds GROUP BY ward_id ORDER BY ward_id`;

export const r2: Scenario = {
  id: 'R2',
  title: 'Лічильники ліжок: HGETALL по відділеннях vs агрегат v_beds',
  engines: ['postgres', 'redis'],
  why: 'Дашборд заповненості опитується постійно з багатьох робочих місць. У PG це агрегат над v_beds (beds ⋈ wards ⋈ departments ⋈ ' +
    'активні admissions ⋈ patients), в Redis — готові лічильники (SMEMBERS + конвеєр HGETALL, один мережевий обмін). Вимірюємо ' +
    'саме читання; ціну підтримки лічильників (HINCRBY після commit + звірка) показує тест packages/redis/tests. ' + INPUTS_NOTE,
  expect: 'Redis у 5–20× швидший і майже не залежить від кількості ліжок; PG росте лінійно з розміром таблиці ліжок.',
  falsifiedIf: 'p50 Redis ≥ p50 PG при ×1 або результати розходяться (сценарій перевіряє рівність перед виміром).',
  async variants(ctx) {
    const r = await redisCtx(ctx, 'r2');
    const { rows } = await ctx.engines.pg.query<{ beds: number; wards: number }>('SELECT count(*)::int AS beds, count(DISTINCT ward_id)::int AS wards FROM v_beds');
    return [{
      id: 'all-wards',
      label: `усі відділення (${rows[0]!.wards} палат, ${rows[0]!.beds} ліжок)`,
      params: rows[0]!,
      ops: [
        { engine: 'postgres', run: () => ctx.engines.pg.query(PG_SQL), explain: async () =>
          (await ctx.engines.pg.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${PG_SQL}`)).rows.map((x) => x['QUERY PLAN']).join('\n') },
        {
          engine: 'redis',
          setup: async () => {
            await clearPrefix(r);
            await reconcile(r, ctx.engines.pg);
            const [a, b] = [await readCounts(r), await countsFromPg(ctx.engines.pg)];
            if (JSON.stringify([...a]) !== JSON.stringify([...b])) throw new Error('R2: Redis counters differ from v_beds after reconcile');
          },
          run: () => readCounts(r),
          teardown: () => clearPrefix(r),
        },
      ],
    }];
  },
};
