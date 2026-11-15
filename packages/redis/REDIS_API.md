# Redis API — довідник команд (Лаб 2, п. 6: «NoSQL іншого типу, базові запити»)

Redis 7.4 (key-value), клієнт `redis` (node-redis) 5.12.1. Схема ключів — `docs/06-nosql-requirements.md` §5.
Усі ключі **й канали pub/sub** мають префікс `${REDIS_PREFIX}:` (`client.ts:23`, схема — `keys` у `client.ts:26`).

Живий прогін кожної команди з цього документа на доменних ключах (друкує команду й відповідь, наприкінці прибирає):

```bash
pnpm --filter @clinic/redis basics        # REDIS_URL=redis://localhost:6380/1, REDIS_PREFIX=w1redis → ключі w1redis:basics:*
```

Позначення складності: N — кількість елементів у ключі, M — кількість аргументів / повернених елементів.
Шляхи — відносно `packages/redis/`.

## Ключі домену

| Ключ | Тип | TTL | Модуль |
|---|---|---|---|
| `slots:{doctorId}:{date}` | string (JSON) | 60 с | `src/slots.ts` |
| `auth:revoked:{jti}` | string | залишок життя JWT | `src/revocation.ts` |
| `beds:ward:{wardId}`, `beds:wards`, `beds:reconciled_at` | hash, set, string | — | `src/beds.ts` |
| `triage:queue`, `triage:entry:{id}`, `triage:seq` | zset, hash (24 год), string | — / 24 год | `src/triage.ts` |
| `icu:vitals`, `icu:latest:{bedId}`, `icu:events` | stream (MAXLEN ~ 100 000), hash (5 хв), list (100) | | `src/icu.ts`, `src/icu-script.ts` |
| канал `alerts:critical` | pub/sub | — | `src/icu-script.ts:37`, `src/icu.ts:137` |

## 1. Рядки (strings)

| Команда | Що робить у нашому домені | Складність | Де в коді |
|---|---|---|---|
| `SET k v EX 60` | кладе JSON вільних слотів лікаря на дату в кеш на 60 с (F-41) | O(1) | `src/slots.ts:16` |
| `GET k` | читає кеш слотів (влучання — без запиту до PG); час останньої звірки ліжок | O(1) | `src/slots.ts:11`, `src/beds.ts:48` |
| `DEL k …` | інвалідація кешу слотів після commit запису (BR-18); прибирання за префіксом | O(M) | `src/slots.ts:21`, `src/client.ts:97` |
| `SET auth:revoked:{jti} 1 EX ttl` | відкликає JWT до його природного завершення (BR-16, D-27) | O(1) | `src/revocation.ts:22` |
| `SET … NX` | «встановити, лише якщо немає» — повторне відкликання нічого не змінює | O(1) | `src/basics.ts:31` |
| `EXISTS k …` | чи відкликано токен (перевірка на кожному запиті) | O(M) | `src/revocation.ts:36` |
| `INCR` / `INCRBY` | атомарний лічильник id записів тріажу `triage:seq` | O(1) | `src/triage.ts:41`, `src/basics.ts:35` |
| `MGET` / `STRLEN` | кілька значень за один обмін / розмір JSON | O(M) / O(1) | `src/basics.ts:36-37` |

## 2. TTL / строк життя

| Команда | Що робить | Складність | Де |
|---|---|---|---|
| `EX` / `PX` в `SET` | строк життя кешу слотів (60 с) і відкликання (залишок JWT) | O(1) | `src/slots.ts:16`, `src/revocation.ts:22` |
| `EXPIRE k s` | запис тріажу живе 24 год, «останні показники» ліжка — 5 хв (тиша монітора → `null`) | O(1) | `src/triage.ts:53`, `src/icu-script.ts:36` |
| `TTL` / `PTTL` | скільки ще житиме ключ (-1 — без строку, -2 — немає) | O(1) | `tests/cache-auth.test.ts`, `src/basics.ts:41` |
| `PERSIST` | зняти строк життя | O(1) | `src/basics.ts:43` |

## 3. Хеші (hashes)

| Команда | Що робить | Складність | Де |
|---|---|---|---|
| `HSET k f v …` | лічильники ліжок відділення при звірці; поля запису тріажу; останні показники ICU | O(M) | `src/beds.ts:81`, `src/triage.ts:45`, `src/icu-script.ts:35` |
| `HINCRBY k free -1` | атомарно змінити кількість вільних / зайнятих ліжок після госпіталізації / виписки (F-43) | O(1) | `src/beds.ts:28,32` |
| `HGETALL k` | лічильники відділення; запис тріажу; останні показники ліжка | O(N) | `src/beds.ts:42`, `src/triage.ts:78`, `src/icu.ts:118` |
| `HGET` / `HMGET` / `HEXISTS` / `HLEN` / `HDEL` | окреме поле / кілька полів / перевірка / розмір / видалення поля | O(1) / O(M) / O(1) / O(1) / O(M) | `src/basics.ts:51-64` |

## 4. Списки (lists)

| Команда | Що робить | Складність | Де |
|---|---|---|---|
| `LPUSH icu:events json` | додати алерт на початок стрічки останніх алертів | O(1) | `src/icu-script.ts:38` |
| `LTRIM icu:events 0 99` | лишити лише 100 останніх (обмежена пам'ять) | O(M) вилучених | `src/icu-script.ts:39` |
| `LRANGE icu:events 0 n` | стрічка алертів для сторінки ICU, новіші першими | O(S+M) | `src/icu.ts:128` |
| `LLEN` / `LINDEX` / `RPOP` | розмір / елемент за індексом / забрати найстаріший | O(1) / O(N) / O(1) | `src/basics.ts:66-73` |

## 5. Множини (sets)

| Команда | Що робить | Складність | Де |
|---|---|---|---|
| `SADD beds:wards id` | реєстр відділень, для яких ведуться лічильники | O(M) | `src/beds.ts:29,33,82` |
| `SMEMBERS beds:wards` | перелік відділень → конвеєр `HGETALL` по кожному | O(N) | `src/beds.ts:40` |
| `SREM` | прибрати відділення, якого вже немає в PG | O(M) | `src/beds.ts:79` |
| `SISMEMBER` / `SCARD` / `SINTER` | перевірка / розмір / перетин (напр. відділення ∩ ICU) | O(1) / O(1) / O(N·M) | `src/basics.ts:75-85` |

## 6. Впорядковані множини (sorted sets) — черга тріажу

| Команда | Що робить | Складність | Де |
|---|---|---|---|
| `ZADD triage:queue score id` | поставити прибулого в чергу; score = `esi·1e13 + arrivalMs` → ESI, потім час (BR-14) | O(log N) | `src/triage.ts:54` |
| `ZRANK` | місце щойно доданого в черзі | O(log N) | `src/triage.ts:55` |
| `ZRANGE q 0 n` | черга в порядку виклику (екран приймального) | O(log N + M) | `src/triage.ts:64` |
| `ZCARD` | довжина черги | O(1) | `src/triage.ts:64,78,83` |
| `ZPOPMIN q` | **викликати наступного**: атомарно, рівно один раз навіть при 32 одночасних постах | O(log N) | `src/triage.ts:75` |
| `ZCOUNT` / `ZRANGE … BYSCORE` / `ZRANGE … WITHSCORES` | скільки ESI 1 / усі ESI 3 / черга з балами | O(log N) / O(log N + M) | `src/basics.ts:87-98` |

## 7. Pub/Sub

| Команда | Що робить | Складність | Де |
|---|---|---|---|
| `PUBLISH <prefix>:alerts:critical json` | миттєва розсилка критичного алерту відкритим SSE-з'єднанням (≤ 2 с, F-44); fire-and-forget | O(N підписників) | `src/icu-script.ts:37` |
| `SUBSCRIBE` / `UNSUBSCRIBE` | API слухає канал на **окремому** з'єднанні (`duplicate()`): підписаний клієнт не виконує інших команд | O(M) | `src/icu.ts:134-139` |
| `PUBSUB NUMSUB` | скільки підписників у каналу | O(M) | `src/basics.ts:109` |

## 8. Стріми (streams) і групи споживачів

| Команда | Що робить | Складність | Де |
|---|---|---|---|
| `XADD icu:vitals MAXLEN ~ 100000 * …` | додати показник монітора; потік обрізається приблизно (цілими вузлами) — пам'ять обмежена | O(1) (+ амортизоване обрізання) | `src/icu-script.ts:32,42` |
| `XREAD BLOCK 1000 STREAMS icu:vitals $` | «хвіст» потоку для SSE (показники в реальному часі) | O(M) | `src/icu.ts:174` |
| `XGROUP CREATE … MKSTREAM` | група `alert-persister`: довготривале збереження алертів у PG | O(1) | `src/icu.ts:197` |
| `XREADGROUP GROUP g c COUNT n BLOCK t STREAMS k >` | отримати нові записи для цього споживача (кожен — одному споживачу групи) | O(M) | `src/icu.ts:222` |
| `XACK` | підтвердити лише ПІСЛЯ `CALL sp_icu_alert_record` (ідемпотентний за stream id) | O(M) | `src/icu.ts:242` |
| `XAUTOCLAIM g c minIdle 0-0` | перехопити записи, які впав-і-не-підтвердив інший екземпляр API | O(M) | `src/icu.ts:219` |
| `XPENDING` / `XINFO GROUPS` | що видано й не підтверджено / стан групи (lag) | O(1)…O(M) | `tests/icu.test.ts`, `src/basics.ts:127,131` |
| `XLEN` / `XRANGE` / `XREVRANGE` / `XTRIM` | розмір / історія за діапазоном id / останній запис / ручне обрізання | O(1) / O(log N + M) / O(N вилучених) | `src/basics.ts:113-132` |

## 9. Транзакції: MULTI / EXEC / WATCH

| Команда | Що робить | Складність | Де |
|---|---|---|---|
| `MULTI … EXEC` | переведення пацієнта між відділеннями: `HINCRBY` двох хешів атомарно — читач не побачить проміжного стану | сума команд | `src/beds.ts:26-35` |
| `MULTI … EXEC` | запис тріажу: `HSET` + `EXPIRE` + `ZADD` + `ZRANK` разом; звірка ліжок перезаписує всі хеші одним блоком | сума команд | `src/triage.ts:44-56`, `src/beds.ts:78-85` |
| `WATCH k` + `MULTI/EXEC` | оптимістичне блокування: якщо інший клієнт змінив ключ між читанням і EXEC, транзакція скасовується (`EXEC → nil`, у клієнті `WatchError`) і повторюється | O(1) на ключ | `src/basics.ts:134-158` |

## 10. Конвеєри (pipelines)

| Прийом | Що робить | Ефект | Де |
|---|---|---|---|
| `multi().…execAsPipeline()` | N команд — один мережевий обмін без атомарності: `HGETALL` усіх відділень, усіх записів черги, останніх показників усіх ліжок ICU | 1000 × `INCR`: ×8–10 швидше за послідовні виклики (вивід `basics`) | `src/beds.ts:41-43`, `src/triage.ts:66-68`, `src/icu.ts:117-119`, `src/basics.ts:161-171` |

## 11. Lua (серверні скрипти)

| Команда | Що робить | Складність | Де |
|---|---|---|---|
| `SCRIPT LOAD` → `EVALSHA` | один скрипт на показник ICU: `XADD` + `HSET`/`EXPIRE` latest + перевірка BR-17 + (за порушення) `PUBLISH` + `LPUSH`/`LTRIM` — атомарно й за один обмін | O(1) + сума команд | `src/icu-script.ts:9`, `src/icu.ts:81-85` |
| `NOSCRIPT` → повторний `SCRIPT LOAD` | після перезапуску Redis кеш скриптів порожній — клієнт перезавантажує скрипт сам | | `src/icu.ts:87-89` |
| `EVAL` | разовий скрипт (демо) | | `src/basics.ts:175` |
| `SCRIPT EXISTS` | чи завантажено скрипт | O(M) | `src/basics.ts:182` |

Пороги BR-17 у Lua і в `fn_icu_violations` (міграція 011) — ті самі й у тому самому порядку; тест
`tests/icu.test.ts` перевіряє кожну межу на обох рушіях.

## 12. Службові

| Команда | Що робить | Де |
|---|---|---|
| `PING` | `/api/health` (F-45): стан і затримка | `src/client.ts:86` |
| `SCAN MATCH prefix:* COUNT n` | обхід ключів префікса без блокування сервера (ніколи `KEYS` у продакшні) | `src/client.ts:96` |
| `TYPE` / `DBSIZE` / `CONFIG GET` | тип ключа / кількість ключів у базі / налаштування (`noeviction`, AOF) | `src/basics.ts:184-193` |

## Деградація (D-28)

Клієнт створюється з `disableOfflineQueue` і обмеженим перепідключенням (`src/client.ts:46`), тому при недоступному Redis
команди **одразу** падають, а не чекають: кеш слотів і лічильники читаються з PG (`cachedSlots`, `countsFromPg`),
відкликання — fail-open з пам'яттю процесу (`RevocationStore`), черга тріажу → 503 `QUEUE_UNAVAILABLE` (рішення API).
