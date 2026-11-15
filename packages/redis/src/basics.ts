import { WatchError } from 'redis';
import { connectRedis, deleteByPrefix, disconnectRedis, type RedisCtx } from './client';
import { ICU_INGEST_LUA } from './icu-script';

// Assignment item 6 — "базові запити" to a NoSQL engine of another type (key-value, Redis).
// Every command group from REDIS_API.md runs against the dev prefix (REDIS_PREFIX:basics:*) on the domain keys
// of docs/06 §5, printing the command and its reply. Everything is deleted at the end.
//   pnpm --filter @clinic/redis basics          (REDIS_URL default redis://localhost:6380/1, prefix w1redis)

const url = process.env.REDIS_URL || 'redis://localhost:6380/1';
const base = await connectRedis({ url, prefix: `${process.env.REDIS_PREFIX || 'w1redis'}:basics` });
const r = base.client;
const k = (s: string) => `${base.prefix}:${s}`;

const fmt = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? String(x) : x));
async function show<T>(cmd: string, run: () => Promise<T>): Promise<T> {
  const res = await run();
  const out = fmt(res);
  console.log(`> ${cmd}\n  ← ${out.length > 220 ? `${out.slice(0, 220)}…` : out}`);
  return res;
}
const section = (title: string) => console.log(`\n=== ${title} ===`);

async function main(ctx: RedisCtx) {
  await deleteByPrefix(ctx);

  section('Рядки (strings): кеш слотів, лічильник id, відкликання JWT');
  const slotsKey = k('slots:3:2030-01-15');
  await show(`SET ${slotsKey} '[…]' EX 60`, () => r.set(slotsKey, '[{"slotStart":"2030-01-15T08:00:00Z"}]', { expiration: { type: 'EX', value: 60 } }));
  await show(`GET ${slotsKey}`, () => r.get(slotsKey));
  await show(`SET ${k('auth:revoked:jti-42')} 1 EX 3600 NX`, () => r.set(k('auth:revoked:jti-42'), '1', { expiration: { type: 'EX', value: 3600 }, condition: 'NX' }));
  await show(`SET … NX again (already revoked)`, () => r.set(k('auth:revoked:jti-42'), '1', { expiration: { type: 'EX', value: 3600 }, condition: 'NX' }));
  await show(`EXISTS ${k('auth:revoked:jti-42')} ${k('auth:revoked:jti-43')}`, () => r.exists([k('auth:revoked:jti-42'), k('auth:revoked:jti-43')]));
  await show(`INCR ${k('triage:seq')}`, () => r.incr(k('triage:seq')));
  await show(`INCRBY ${k('triage:seq')} 10`, () => r.incrBy(k('triage:seq'), 10));
  await show(`MGET ${slotsKey} ${k('triage:seq')}`, () => r.mGet([slotsKey, k('triage:seq')]));
  await show(`STRLEN ${slotsKey}`, () => r.strLen(slotsKey));

  section('TTL / строк життя');
  await show(`TTL ${slotsKey}`, () => r.ttl(slotsKey));
  await show(`PTTL ${k('auth:revoked:jti-42')}`, () => r.pTTL(k('auth:revoked:jti-42')));
  await show(`EXPIRE ${k('triage:seq')} 120`, () => r.expire(k('triage:seq'), 120));
  await show(`PERSIST ${k('triage:seq')}`, () => r.persist(k('triage:seq')));
  await show(`TTL ${k('triage:seq')}  (-1 = без строку)`, () => r.ttl(k('triage:seq')));
  await show(`SET ${k('tmp')} x PX 50; (пауза 80 мс) GET`, async () => {
    await r.set(k('tmp'), 'x', { expiration: { type: 'PX', value: 50 } });
    await new Promise((res) => setTimeout(res, 80));
    return r.get(k('tmp'));
  });

  section('Хеші (hashes): лічильники ліжок, запис тріажу, останні показники ICU');
  const ward = k('beds:ward:5');
  await show(`HSET ${ward} free 3 occupied 1`, () => r.hSet(ward, { free: 3, occupied: 1 }));
  await show(`HINCRBY ${ward} free -1`, () => r.hIncrBy(ward, 'free', -1));
  await show(`HINCRBY ${ward} occupied 1`, () => r.hIncrBy(ward, 'occupied', 1));
  await show(`HGET ${ward} free`, () => r.hGet(ward, 'free'));
  await show(`HMGET ${ward} free occupied`, () => r.hmGet(ward, ['free', 'occupied']));
  await show(`HGETALL ${ward}`, () => r.hGetAll(ward));
  await show(`HEXISTS ${ward} maintenance`, () => r.hExists(ward, 'maintenance'));
  await show(`HLEN ${ward}`, () => r.hLen(ward));
  await show(`HSET ${k('triage:entry:7')} … ; HDEL complaint`, async () => {
    await r.hSet(k('triage:entry:7'), { id: 7, patientName: 'Невідомий', esi: 2, complaint: 'біль у грудях' });
    return r.hDel(k('triage:entry:7'), 'complaint');
  });

  section('Списки (lists): останні 100 алертів ICU');
  const events = k('icu:events');
  for (const n of [1, 2, 3]) await show(`LPUSH ${events} alert#${n}`, () => r.lPush(events, `{"alert":${n}}`));
  await show(`LRANGE ${events} 0 -1  (новіші першими)`, () => r.lRange(events, 0, -1));
  await show(`LTRIM ${events} 0 1  (лишити 2 останні)`, () => r.lTrim(events, 0, 1));
  await show(`LLEN ${events}`, () => r.lLen(events));
  await show(`LINDEX ${events} 0`, () => r.lIndex(events, 0));
  await show(`RPOP ${events}  (найстаріший)`, () => r.rPop(events));

  section('Множини (sets): перелік відділень з лічильниками');
  const wards = k('beds:wards');
  await show(`SADD ${wards} 5 6 7 5`, () => r.sAdd(wards, ['5', '6', '7', '5']));
  await show(`SMEMBERS ${wards}`, () => r.sMembers(wards).then((m) => m.sort()));
  await show(`SISMEMBER ${wards} 6`, () => r.sIsMember(wards, '6'));
  await show(`SCARD ${wards}`, () => r.sCard(wards));
  await show(`SREM ${wards} 7`, () => r.sRem(wards, '7'));
  await show(`SINTER ${wards} {5,9}`, async () => {
    await r.sAdd(k('icu:wards'), ['5', '9']);
    return r.sInter([wards, k('icu:wards')]);
  });

  section('Впорядковані множини (sorted sets): черга тріажу, score = esi·1e13 + час прибуття');
  const q = k('triage:queue');
  const t0 = Date.UTC(2030, 0, 15, 9, 0);
  await show(`ZADD ${q} 3e13+t 000000000001 1e13+t+60000 000000000002 3e13+t+5000 000000000003`, () =>
    r.zAdd(q, [{ score: 3e13 + t0, value: '000000000001' }, { score: 1e13 + t0 + 60_000, value: '000000000002' }, { score: 3e13 + t0 + 5_000, value: '000000000003' }]));
  await show(`ZRANGE ${q} 0 -1 WITHSCORES`, () => r.zRangeWithScores(q, 0, -1));
  await show(`ZRANK ${q} 000000000003`, () => r.zRank(q, '000000000003'));
  await show(`ZCARD ${q}`, () => r.zCard(q));
  await show(`ZCOUNT ${q} 1e13 2e13-1  (скільки ESI 1)`, () => r.zCount(q, 1e13, 2e13 - 1));
  await show(`ZRANGE ${q} 3e13 4e13-1 BYSCORE  (усі ESI 3)`, () => r.zRange(q, 3e13, 4e13 - 1, { BY: 'SCORE' }));
  await show(`ZPOPMIN ${q}  (викликати наступного: ESI 1, хоч прибув пізніше)`, () => r.zPopMin(q));
  await show(`ZPOPMIN ${q}`, () => r.zPopMin(q));

  section('Pub/Sub: канал критичних алертів (окреме зʼєднання для SUBSCRIBE)');
  const channel = k('alerts:critical');
  const sub = r.duplicate();
  await sub.connect();
  const received: string[] = [];
  await show(`SUBSCRIBE ${channel}`, () => sub.subscribe(channel, (m) => received.push(m)).then(() => 'subscribed'));
  await show(`PUBLISH ${channel} '{"bedId":40,"sign":"spo2"}'  (кількість отримувачів)`, () => r.publish(channel, '{"bedId":40,"sign":"spo2"}'));
  await new Promise((res) => setTimeout(res, 50));
  await show('(отримано підписником)', async () => received);
  await show(`PUBSUB NUMSUB ${channel}`, () => r.pubSubNumSub(channel));
  await sub.unsubscribe();
  await sub.quit();

  section('Стріми (streams) + групи споживачів: сирі показники ICU');
  const stream = k('icu:vitals');
  const ids: string[] = [];
  for (const hr of [82, 35, 90]) {
    ids.push(await show(`XADD ${stream} MAXLEN ~ 100000 * bed 40 hr ${hr}`, () =>
      r.xAdd(stream, '*', { bed: '40', hr: String(hr) }, { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 100_000 } })));
  }
  await show(`XLEN ${stream}`, () => r.xLen(stream));
  await show(`XRANGE ${stream} - + COUNT 2`, () => r.xRange(stream, '-', '+', { COUNT: 2 }));
  await show(`XREVRANGE ${stream} + - COUNT 1  (останній)`, () => r.xRevRange(stream, '+', '-', { COUNT: 1 }));
  await show(`XREAD COUNT 10 STREAMS ${stream} ${ids[0]}  (усе після першого)`, () => r.xRead({ key: stream, id: ids[0]! }, { COUNT: 10 }));
  await show(`XGROUP CREATE ${stream} alert-persister 0`, () => r.xGroupCreate(stream, 'alert-persister', '0'));
  await show(`XREADGROUP GROUP alert-persister api-1 COUNT 2 STREAMS ${stream} >`, () =>
    r.xReadGroup('alert-persister', 'api-1', { key: stream, id: '>' }, { COUNT: 2 }));
  await show(`XPENDING ${stream} alert-persister  (видано, не підтверджено)`, () => r.xPending(stream, 'alert-persister'));
  await show(`XACK ${stream} alert-persister ${ids[0]}`, () => r.xAck(stream, 'alert-persister', ids[0]!));
  await show(`XAUTOCLAIM ${stream} alert-persister api-2 0 0-0  (перехопити завислі після збою api-1)`, () =>
    r.xAutoClaim(stream, 'alert-persister', 'api-2', 0, '0-0'));
  await show(`XINFO GROUPS ${stream}`, () => r.xInfoGroups(stream));
  await show(`XTRIM ${stream} MAXLEN 1`, () => r.xTrim(stream, 'MAXLEN', 1));

  section('Транзакції: MULTI/EXEC (переведення пацієнта між відділеннями) і WATCH (оптимістичне блокування)');
  const w6 = k('beds:ward:6');
  await r.hSet(w6, { free: 2, occupied: 2 });
  await show(`MULTI; HINCRBY ${ward} free 1; HINCRBY ${ward} occupied -1; HINCRBY ${w6} free -1; HINCRBY ${w6} occupied 1; EXEC`, () =>
    r.multi().hIncrBy(ward, 'free', 1).hIncrBy(ward, 'occupied', -1).hIncrBy(w6, 'free', -1).hIncrBy(w6, 'occupied', 1).exec());
  const a = r.duplicate();
  await a.connect();
  await show(`[A] WATCH ${w6}; [A] HGET free`, async () => {
    await a.watch(w6);
    return a.hGet(w6, 'free');
  });
  await show(`[B] HINCRBY ${w6} free -1  (інший клієнт встиг змінити)`, () => r.hIncrBy(w6, 'free', -1));
  await show(`[A] MULTI; HSET ${w6} free 0; EXEC  → транзакцію скасовано`, async () => {
    try {
      await a.multi().hSet(w6, 'free', 0).exec();
      return 'EXEC applied';
    } catch (e) {
      return e instanceof WatchError ? `WatchError: ${e.message} (EXEC → nil)` : `error ${(e as Error).message}`;
    }
  });
  await show(`[A] WATCH; HGET; MULTI; HSET free <read-1>; EXEC  (повтор без конфлікту)`, async () => {
    await a.watch(w6);
    const free = Number(await a.hGet(w6, 'free'));
    return a.multi().hSet(w6, 'free', free - 1).exec();
  });
  await a.quit();

  section('Конвеєр (pipeline): 1000 команд за один мережевий обмін');
  const N = 1000;
  let t = performance.now();
  for (let i = 0; i < N; i++) await r.incr(k('bench:seq'));
  const seq = performance.now() - t;
  t = performance.now();
  const p = r.multi();
  for (let i = 0; i < N; i++) p.incr(k('bench:seq'));
  await p.execAsPipeline();
  const pip = performance.now() - t;
  console.log(`> ${N}× INCR послідовно: ${seq.toFixed(1)} мс; ${N}× INCR конвеєром: ${pip.toFixed(1)} мс (×${(seq / pip).toFixed(1)})`);
  await show(`GET ${k('bench:seq')}`, () => r.get(k('bench:seq')));

  section('Lua: атомарний скрипт на сервері (інжест показника ICU = XADD + HSET + перевірка BR-17 + PUBLISH)');
  await show(`EVAL "return redis.call('HINCRBY', KEYS[1], 'free', ARGV[1])" 1 ${ward} 1`, () =>
    r.eval("return redis.call('HINCRBY', KEYS[1], 'free', ARGV[1])", { keys: [ward], arguments: ['1'] }));
  const sha = await show('SCRIPT LOAD <icu-ingest.lua>', () => r.scriptLoad(ICU_INGEST_LUA));
  const icuArgs = (hr: number) => [k('alerts:critical'), '40', '', String(Date.UTC(2030, 0, 15, 9)), String(hr), '97', '120', '75', '16', '36.8', '100000', '300', '100'];
  const icuKeys = [k('icu:vitals'), k('icu:latest:40'), k('icu:events')];
  await show(`EVALSHA ${sha.slice(0, 12)}… 3 icu:vitals icu:latest:40 icu:events … hr 82  (норма)`, () => r.evalSha(sha, { keys: icuKeys, arguments: icuArgs(82) }));
  await show(`EVALSHA … hr 35  (критично: < 40 → алерт)`, () => r.evalSha(sha, { keys: icuKeys, arguments: icuArgs(35) }));
  await show(`SCRIPT EXISTS ${sha.slice(0, 12)}…`, () => r.scriptExists(sha));

  section('Службові');
  await show(`SCAN 0 MATCH ${base.prefix}:* COUNT 100  (ніколи не KEYS у продакшні)`, async () => {
    const found: string[] = [];
    for await (const batch of r.scanIterator({ MATCH: `${base.prefix}:*`, COUNT: 100 })) found.push(...batch);
    return found.length;
  });
  await show(`TYPE ${q} / ${stream} / ${ward}`, async () => [await r.type(q), await r.type(stream), await r.type(ward)]);
  await show('DBSIZE', () => r.dbSize());
  await show('CONFIG GET maxmemory-policy', () => r.configGet('maxmemory-policy'));
  await show('cleanup: DEL усіх ключів демо', () => deleteByPrefix(ctx));
}

try {
  await main(base);
} finally {
  await disconnectRedis(base);
}
