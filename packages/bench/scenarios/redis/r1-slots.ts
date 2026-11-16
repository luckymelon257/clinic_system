import type { Scenario } from '../../src/types';
import { cachedSlots, getSlots, invalidateSlots, setSlots } from '@clinic/redis';
import { clearPrefix, explainPg, INPUTS_NOTE, redisCtx } from './common';

const SQL = 'SELECT slot_start, slot_end FROM fn_doctor_free_slots($1, $2::date)';

export const r1: Scenario = {
  id: 'R1',
  title: 'Вільні слоти лікаря: кеш Redis vs fn_doctor_free_slots',
  engines: ['postgres', 'redis'],
  why: 'Розклад читають набагато частіше, ніж записують (кожне відкриття форми запису), а fn_doctor_free_slots щоразу генерує сітку ' +
    'слотів і перевіряє перетин з прийомами. Кеш має сенс лише якщо влучання суттєво дешевше за запит, а промах не надто дорожчий. ' +
    'Тому два варіанти: влучання (GET + JSON.parse) і промах (DEL → GET → PG → SET EX 60), обидва проти чистого PG. ' + INPUTS_NOTE,
  expect: 'Влучання в 3–10× швидше за PG (один GET проти генерації сітки й anti-join); промах повільніший за PG на 2–3 мережеві обміни з Redis.',
  falsifiedIf: 'p50 влучання ≥ p50 PG (кеш не виграє навіть у найкращому випадку) або промах дорожчий за PG більш ніж на 1 мс.',
  async variants(ctx) {
    const { rows } = await ctx.engines.pg.query<{ doctor_id: number; day: string }>(`
      SELECT s.doctor_id, to_char(current_date + d, 'YYYY-MM-DD') AS day
      FROM doctor_schedules s CROSS JOIN generate_series(1, 14) d
      WHERE s.weekday = extract(isodow FROM current_date + d)
      ORDER BY s.doctor_id, d LIMIT 64`);
    if (!rows.length) throw new Error('R1: no doctor schedules in the next 14 days');
    const pairs = rows.map((r) => [r.doctor_id, r.day] as const);
    const pick = (i: number) => pairs[i % pairs.length]!;
    const pgOp = {
      engine: 'postgres' as const,
      run: (i: number) => ctx.engines.pg.query(SQL, [...pick(i)]),
      explain: () => explainPg(ctx, SQL, [...pairs[0]!]),
    };
    const r = await redisCtx(ctx, 'r1');
    const load = (doctorId: number, day: string) => async () => (await ctx.engines.pg.query(SQL, [doctorId, day])).rows;
    return [
      {
        id: 'hit',
        label: 'влучання в кеш',
        params: { pairs: pairs.length, ttlSeconds: 3600 },
        ops: [pgOp, {
          engine: 'redis',
          // TTL 1 h only so the cache cannot expire mid-measurement; production TTL is 60 s (SLOT_TTL_SECONDS)
          setup: async () => {
            await clearPrefix(r);
            for (const [d, day] of pairs) await setSlots(r, d, day, await load(d, day)(), 3600);
          },
          run: async (i: number) => {
            const [d, day] = pick(i);
            if (!(await getSlots(r, d, day))) throw new Error(`R1 hit: cache miss for ${d} ${day}`);
          },
          teardown: () => clearPrefix(r),
        }],
      },
      {
        id: 'miss',
        label: 'промах + заповнення',
        params: { pairs: pairs.length, ttlSeconds: 60 },
        ops: [pgOp, {
          engine: 'redis',
          run: async (i: number) => {
            const [d, day] = pick(i);
            await invalidateSlots(r, d, day);
            const res = await cachedSlots(r, d, day, load(d, day));
            if (res.source !== 'postgres') throw new Error('R1 miss: expected a miss');
          },
          teardown: () => clearPrefix(r),
        }],
      },
    ];
  },
};
