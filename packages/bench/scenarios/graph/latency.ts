import { admissionsByDeptMonth, DEPT_MONTH_QUERY, drugInteractions, exposurePath, INTERACTIONS_QUERY, pathQuery, traceContacts, traceQuery } from '@clinic/graph';
import neo4j from 'neo4j-driver';
import type { BenchContext, EngineOp, Scenario, Variant } from '../../src/types';
import { explainPg, graphParams, pick, preflight, profileCypher, SQL, type PathPair, type Window } from './common';

// S1–S5: latency scenarios (the harness measures every op). The NoSQL op is always LAST, so the report's
// ratio line reads "postgres / neo4j" (> 1 = Neo4j faster).

const ms = (s: string) => Date.parse(s);
const int = (x: number) => neo4j.int(x); // ids and epoch ms are stored as INTEGER in Neo4j (D-45)

function traceOps(ctx: BenchContext, ids: readonly number[], w: Window, depth: number, withCte: boolean): EngineOp[] {
  const pg = ctx.engines.pg;
  const args = (i: number) => ['patient', pick(ids, i), w.from, w.to, depth];
  const ops: EngineOp[] = [];
  if (withCte) {
    ops.push({
      engine: 'postgres', label: 'pg-cte',
      run: (i) => pg.query(SQL.traceCte, args(i)),
      explain: () => explainPg(pg, SQL.traceCte, args(0)),
    });
  }
  ops.push({
    engine: 'postgres', label: 'pg-bfs',
    run: (i) => pg.query(SQL.traceBfs, args(i)),
    explain: () => explainPg(pg, SQL.traceBfs, args(0)),
  });
  ops.push({
    engine: 'neo4j', label: 'neo4j',
    setup: () => preflight(ctx),
    run: (i) => traceContacts(ctx.engines.neo4j, { kind: 'patient', id: pick(ids, i), from: w.from, to: w.to, depth }, ctx.measure.timeoutMs),
    explain: () => profileCypher(ctx.engines.neo4j, traceQuery('patient', depth), { id: int(ids[0]!), from: int(ms(w.from)), to: int(ms(w.to)) }),
  });
  return ops;
}

export const s1: Scenario = {
  id: 'S1',
  title: 'Відстеження контактів, глибина 1–5 (вікно 14 днів)',
  engines: ['postgres', 'neo4j'],
  why: 'Головне питання роботи: чи дає графова модель виграш на багатокрокових обходах. Глибина — єдиний параметр, від якого вартість SQL росте як розмір фронту в степені кроку; 200 індексних пацієнтів, активних у вікні, — ті самі, що в гейті щільності, тож розмір кроків відомий (d1 p50 ≈ 50, d2 ≈ 500 на ×1). Рекурсивний CTE міряється лише до глибини 3: на глибині 3 він уже виходить за таймаут 30 с, далі були б самі таймаути.',
  expect: 'd1 — паритет або перемога PG (один GiST-пошук); з глибиною Neo4j виграє в pg-cte на порядки (CTE не дедуплікує осіб між кроками), а відносно pg-bfs (дедуплікація фронту) — у рази або паритет; з масштабом ×5/×10 перевага Neo4j не зменшується.',
  falsifiedIf: 'pg-bfs не повільніший за Neo4j на глибині ≥ 3 на всіх масштабах — тоді винесення в граф не виправдане для цього навантаження.',
  measure: { minSamples: 3 },
  async variants(ctx) {
    const p = graphParams(ctx);
    return [1, 2, 3, 4, 5].map((d): Variant => ({
      id: `d${d}`, label: `глибина ${d}`, params: { depth: d, window: '14 d', indexes: p.trace.length },
      ops: traceOps(ctx, p.trace, p.windows.d14, d, d <= 3),
    }));
  },
};

export const s2: Scenario = {
  id: 'S2',
  title: 'Відстеження контактів глибини 3: вікно 3 / 14 / 60 днів',
  engines: ['postgres', 'neo4j'],
  why: 'Вікно — другий множник вартості: кількість присутностей, що перетинають вікно, росте лінійно з його довжиною, а розмір кроку — надлінійно. Особи однакові для всіх вікон (активні в 3-денному ⊂ 14 ⊂ 60), тож різниця — лише від вікна. PG фільтрує вікно GiST-індексом, Neo4j — після розгортання ребер (індексу на час у ребрі обходу не використати).',
  expect: 'Обидва рушії сповільнюються з вікном; відносна перевага Neo4j зменшується на 60 днях, бо зростає частка ребер, що відкидаються фільтром часу після обходу.',
  falsifiedIf: 'Час Neo4j не залежить від вікна (тоді вартість визначає не фільтр, а щось інше) або PG сповільнюється сильніше за Neo4j.',
  measure: { minSamples: 3 },
  async variants(ctx) {
    const p = graphParams(ctx);
    return (['d3', 'd14', 'd60'] as const).map((k): Variant => ({
      id: k, label: `вікно ${k.slice(1)} д`, params: { depth: 3, window: p.windows[k] },
      ops: traceOps(ctx, p.traceShort, p.windows[k], 3, false),
    }));
  },
};

export const s3: Scenario = {
  id: 'S3',
  title: 'Найкоротший ланцюг експозиції: відстань 2 / 4 / не пов’язані',
  engines: ['postgres', 'neo4j'],
  why: 'Пошук шляху зупиняється, щойно знайдено ціль, тож вартість залежить від відстані; «не пов’язані» — найгірший випадок (обхід до maxDepth = 6). Пари підібрано заздалегідь PG BFS і перевірено гейтом еквівалентності (довжина однакова в обох рушіях).',
  expect: 'Відстань 2 — паритет; відстань 4 і «не пов’язані» — перевага Neo4j зростає з кількістю кроків.',
  falsifiedIf: 'PG не повільніший на відстані 4 і для непов’язаних пар.',
  measure: { minSamples: 3 },
  async variants(ctx) {
    const p = graphParams(ctx);
    const w = p.windows.d14;
    return (['d2', 'd4', 'unreachable'] as const).map((k): Variant => {
      const pairs: PathPair[] = p.paths[k];
      const args = (i: number) => {
        const pp = pick(pairs, i);
        return [pp.a.kind, pp.a.id, pp.b.kind, pp.b.id, w.from, w.to, pp.maxDepth];
      };
      return {
        id: k, label: k === 'unreachable' ? 'не пов’язані' : `відстань ${k.slice(1)}`, params: { pairs: pairs.length, maxDepth: pairs[0]?.maxDepth },
        ops: [
          { engine: 'postgres', label: 'pg-bfs', run: (i) => ctx.engines.pg.query(SQL.path, args(i)), explain: () => explainPg(ctx.engines.pg, SQL.path, args(0)) },
          {
            engine: 'neo4j', label: 'neo4j', setup: () => preflight(ctx),
            run: (i) => {
              const pp = pick(pairs, i);
              return exposurePath(ctx.engines.neo4j, { aKind: pp.a.kind, aId: pp.a.id, bKind: pp.b.kind, bId: pp.b.id, from: w.from, to: w.to, maxDepth: pp.maxDepth }, ctx.measure.timeoutMs);
            },
            explain: () => {
              const pp = pairs[0]!;
              return profileCypher(ctx.engines.neo4j, pathQuery(pp.a.kind, pp.b.kind, pp.maxDepth), { aId: int(pp.a.id), bId: int(pp.b.id), from: int(ms(w.from)), to: int(ms(w.to)) });
            },
          },
        ],
      };
    });
  },
};

export const s4: Scenario = {
  id: 'S4',
  title: 'Перевірка взаємодії ліків: 1 / 5 / 15 препаратів',
  engines: ['postgres', 'neo4j'],
  why: 'Взаємодія через класи — граф глибиною 2 (препарат → клас → клас), але з крихітним довідником (600 препаратів, 80 класів, 550 взаємодій), що повністю в кеші обох рушіїв. Це навмисно сценарій, де графова модель не повинна вигравати: показує, що «граф» сам по собі не означає швидше. Набори препаратів вибрано пропорційно реальній частоті призначень.',
  expect: 'PG рівний або швидший (кілька index lookup і join малих таблиць; накладні витрати Bolt і планувальника Cypher порівнянні з самим запитом). Різниця росте з 15 препаратами (105 пар) мало.',
  falsifiedIf: 'Neo4j стабільно швидший у ≥ 2 рази на всіх розмірах набору.',
  async variants(ctx) {
    const p = graphParams(ctx);
    const variants: Variant[] = (['m1', 'm5', 'm15'] as const).map((k) => ({
      id: k, label: `${k.slice(1)} препарат(ів)`, params: { sets: p.meds[k].length, size: Number(k.slice(1)) },
      ops: medOps(ctx, (i) => ({ ids: pick(p.meds[k], i), patientId: null, at: null })),
    }));
    variants.push({
      id: 'patient', label: 'пацієнт + 1 новий', params: { sets: p.meds.patient.length },
      ops: medOps(ctx, (i) => { const x = pick(p.meds.patient, i); return { ids: x.medicationIds, patientId: x.patientId, at: x.at }; }),
    });
    return variants;
  },
};

function medOps(ctx: BenchContext, arg: (i: number) => { ids: number[]; patientId: number | null; at: string | null }): EngineOp[] {
  const sqlArgs = (i: number) => { const a = arg(i); return [a.ids, a.patientId, a.at ?? new Date().toISOString()]; };
  return [
    { engine: 'postgres', label: 'pg', run: (i) => ctx.engines.pg.query(SQL.interactions, sqlArgs(i)), explain: () => explainPg(ctx.engines.pg, SQL.interactions, sqlArgs(0)) },
    {
      engine: 'neo4j', label: 'neo4j', setup: () => preflight(ctx),
      run: (i) => { const a = arg(i); return drugInteractions(ctx.engines.neo4j, { medicationIds: a.ids, patientId: a.patientId, at: a.at }, ctx.measure.timeoutMs); },
      explain: () => { const a = arg(0); return profileCypher(ctx.engines.neo4j, INTERACTIONS_QUERY, { ids: a.ids.map((x) => int(x)), patientId: int(a.patientId ?? -1), at: int(a.at ? ms(a.at) : Date.now()) }); },
    },
  ];
}

export const s5: Scenario = {
  id: 'S5',
  title: 'Плаский агрегат: госпіталізації по відділеннях по місяцях',
  engines: ['postgres', 'neo4j'],
  why: 'Типовий звіт без обходу: скан + групування. Включений, щоб показати, де графова модель програє: Neo4j мусить пройти всі ребра PRESENT (src = admission) і перетворити час, PG — індекс за датою і hash aggregate. Без цього сценарію порівняння було б упереджене на користь графа.',
  expect: 'PG швидший щонайменше в 10 разів на рік даних; різниця росте з масштабом.',
  falsifiedIf: 'Neo4j у межах 2× від PG.',
  async variants(ctx) {
    const p = graphParams(ctx);
    return p.deptMonth.map((r, k): Variant => ({
      id: `r${k}`, label: k === 0 ? 'рік' : 'квартал', params: r,
      ops: [
        { engine: 'postgres', label: 'pg', run: () => ctx.engines.pg.query(SQL.deptMonth, [r.from, r.to]), explain: () => explainPg(ctx.engines.pg, SQL.deptMonth, [r.from, r.to]) },
        {
          engine: 'neo4j', label: 'neo4j', setup: () => preflight(ctx),
          run: () => admissionsByDeptMonth(ctx.engines.neo4j, { from: kyivMidnight(r.from), to: kyivMidnight(r.to) }, ctx.measure.timeoutMs),
          explain: () => profileCypher(ctx.engines.neo4j, DEPT_MONTH_QUERY, { from: int(Date.parse(kyivMidnight(r.from))), to: int(Date.parse(kyivMidnight(r.to))) }),
        },
      ],
    }));
  },
};

/** 'YYYY-MM-DD' → that midnight in Europe/Kyiv as ISO (PG compares the date in the database time zone). */
function kyivMidnight(d: string): string {
  const guess = new Date(`${d}T00:00:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', timeZoneName: 'shortOffset' })
    .formatToParts(guess).find((x) => x.type === 'timeZoneName')!.value; // e.g. GMT+2
  const h = Number(off.replace('GMT', '') || 0);
  return new Date(guess.getTime() - h * 3_600_000).toISOString();
}
