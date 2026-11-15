import type { Scenario } from '../../src/types';
import { keys, triageCallNext, triageScore } from '@clinic/redis';
import { clearPrefix, explainPg, redisCtx } from './common';

// Both queues are pre-filled with the SAME N entries (esi = 1 + (i·7919) mod 5, arrival t0 + i ms), large enough that
// no run can drain them: a pop that finds the queue empty fails the scenario. After all runs the popped ids must be
// unique and equal the first K entries in priority order — exactly-once + BR-14, checked for both engines.
const N = 40_000;
const T0 = Date.UTC(2030, 0, 1);
const esiOf = (i: number) => 1 + ((i * 7919) % 5);

function topK(k: number): Set<number> {
  const all = Array.from({ length: N }, (_, i) => ({ id: i + 1, esi: esiOf(i), at: T0 + i }));
  all.sort((a, b) => a.esi - b.esi || a.at - b.at || a.id - b.id);
  return new Set(all.slice(0, k).map((e) => e.id));
}

function verify(engine: string, popped: number[]) {
  const set = new Set(popped);
  if (set.size !== popped.length) throw new Error(`R3 ${engine}: duplicate pops (${popped.length - set.size})`);
  const expected = topK(popped.length);
  for (const id of set) if (!expected.has(id)) throw new Error(`R3 ${engine}: id ${id} popped while a higher-priority entry was still waiting`);
}

export const r3: Scenario = {
  id: 'R3',
  title: 'Черга тріажу: ZPOPMIN vs FOR UPDATE SKIP LOCKED',
  engines: ['postgres', 'redis'],
  why: 'BR-14 вимагає, щоб кожного пацієнта викликали рівно один раз у порядку ESI → час прибуття, навіть коли «наступного» ' +
    'натискають одночасно кілька постів. У PG це UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) з частковим індексом ' +
    '(запис у WAL, блокування рядка, мертвий кортеж), у Redis — атомарний ZPOPMIN O(log N). Конкурентність 1/8/32 показує, ' +
    'як кожен рушій поводиться під конкуренцією за «голову» черги. Обидві черги заздалегідь заповнені однаковими 40 000 записів.',
  expect: 'Redis у 3–10× швидший на c = 1 і масштабується краще (однопотоковий цикл подій без блокувань рядків); PG під 32 споживачами ' +
    'упирається в fsync/WAL і пропуск заблокованих рядків. Обидва — без дублікатів і з правильним порядком.',
  falsifiedIf: 'будь-який дублікат або порушення порядку (сценарій падає), або p50 PG ≤ p50 Redis на c = 1.',
  async variants(ctx) {
    const r = await redisCtx(ctx, 'r3');
    const poppedRedis: number[] = [];
    const poppedPg: number[] = [];
    return [{
      id: 'pop',
      label: `черга ${N.toLocaleString('en-US')} записів`,
      params: { prefill: N, esi: '1 + (i·7919) mod 5', arrival: 't0 + i ms' },
      ops: [
        {
          engine: 'postgres',
          setup: async () => {
            await ctx.engines.pg.query('TRUNCATE triage_queue_pg RESTART IDENTITY');
            await ctx.engines.pg.query(`INSERT INTO triage_queue_pg (patient_name, esi, complaint, arrived_at)
              SELECT 'p' || i, 1 + (i * 7919) % 5, 'bench', to_timestamp($2::double precision / 1000) + i * interval '1 millisecond'
              FROM generate_series(0, $1 - 1) i ORDER BY i`, [N, T0]);
            await ctx.engines.pg.query('VACUUM ANALYZE triage_queue_pg');
          },
          run: async () => {
            const { rows } = await ctx.engines.pg.query<{ id: string }>('SELECT * FROM fn_triage_pop()');
            if (!rows[0]) throw new Error('R3 postgres: queue ran dry');
            poppedPg.push(Number(rows[0].id));
          },
          explain: () => explainPg(ctx, 'SELECT * FROM fn_triage_pop()', []),
          teardown: async () => verify('postgres', poppedPg),
        },
        {
          engine: 'redis',
          setup: async () => {
            await clearPrefix(r);
            for (let i = 0; i < N; i += 2_000) {
              const m = r.client.multi();
              for (let j = i; j < Math.min(N, i + 2_000); j++) {
                const id = j + 1;
                m.hSet(`${r.prefix}:${keys.triageEntry(id)}`, { id, patientId: '', patientName: `p${j}`, esi: esiOf(j), complaint: 'bench', arrivedMs: T0 + j });
                m.zAdd(`${r.prefix}:${keys.triageQueue}`, { score: triageScore(esiOf(j), T0 + j), value: String(id).padStart(12, '0') });
              }
              await m.execAsPipeline();
            }
          },
          run: async () => {
            const { entry } = await triageCallNext(r);
            if (!entry) throw new Error('R3 redis: queue ran dry');
            poppedRedis.push(entry.id);
          },
          teardown: async () => {
            verify('redis', poppedRedis);
            await clearPrefix(r);
          },
        },
      ],
    }];
  },
};
