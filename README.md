# clinic_system

Система управління лікарнею: PostgreSQL 16 + Express/TypeScript (`pg`, без ORM) + React/Vite. Монорепо pnpm + Turborepo.
Лаб 2 (NoSQL): Neo4j 5.26 (граф контактів і взаємодій ліків) + Redis 7.4 (оперативний стан) поруч із PostgreSQL.

## Запуск з нуля

Потрібно: Docker, Node 20+ (рекомендовано 22), pnpm 10. Один раз: `pnpm install` (і `cp .env.example .env`, якщо треба змінити налаштування).

```bash
docker compose up -d db   # postgres:16 → localhost:5434
pnpm db:reset             # міграції + довідники + демо-дані + обсяг (~10k пацієнтів, ~100k прийомів), ≈1.5 хв
pnpm dev                  # API + UI
```

| Що | URL |
|---|---|
| UI | http://localhost:5173 |
| API | http://localhost:4000/api |
| Swagger UI | http://localhost:4000/api/docs (OpenAPI JSON: `/api/openapi.json`) |

## Демо-входи

| Роль | Email | Пароль |
|---|---|---|
| Адміністратор | `admin@clinic.local` | `admin123` |
| Реєстратор | `registrar@clinic.local` | `registrar123` |
| Лікар | `doctor@clinic.local` | `doctor123` |
| Лаборант | `lab@clinic.local` | `lab123` |
| Касир | `cashier@clinic.local` | `cashier123` |
| Пацієнт | `patient@clinic.local` | `patient123` |

UI без API: `VITE_USE_MOCKS=1 pnpm --filter @clinic/web dev` (MSW-моки).

## Лаб 2: NoSQL (Neo4j + Redis)

```bash
pnpm nosql:up                                   # db + neo4j (bolt :7688, http :7475) + redis (:6380)
pnpm db:reset                                   # міграції 001–012 + seed
pnpm graph:sync --full                          # повний ETL PostgreSQL → Neo4j
pnpm graph:sync --follow                        # воркер синхронізації (outbox), лишити запущеним
pnpm simulate                                   # симулятор показників ВІТ → Redis Stream
pnpm dev                                        # нові сторінки: Відстеження контактів, Монітор ВІТ, Тріаж
pnpm --filter @clinic/redis basics              # базові запити Redis (усі групи команд)
```

Бенчмарк PostgreSQL vs Neo4j / Redis:

```bash
pnpm --filter @clinic/graph gen -- --scale 1         # бенч-база clinic_bench_x1 (також 5, 10)
pnpm --filter @clinic/graph validate -- --scale 1    # перевірка щільності контактів
pnpm --filter @clinic/bench equivalence -- --scale x1   # однаковість відповідей PG і Neo4j
cd packages/bench && ./run-all.sh                    # усі сценарії; звіти → packages/bench/report/
```

## Структура

| Пакет | Що всередині |
|---|---|
| `packages/db` | SQL-міграції `001…012` (Лаб 2: `009…012`), seed-и, SQL-тести, `reports/explain.md`, [`SQL_API.md`](packages/db/SQL_API.md) |
| `packages/graph` | Лаб 2: схема й запити Neo4j, ETL і outbox-синхронізація, генератор бенч-даних, еталонна фікстура |
| `packages/redis` | Лаб 2: кеш слотів, відкликання JWT, лічильники ліжок, черга тріажу, ВІТ (Lua, Streams), [`REDIS_API.md`](packages/redis/REDIS_API.md) |
| `packages/bench` | Лаб 2: harness бенчмарків, сценарії S1–S8 / R1–R4, гейт еквівалентності, результати й звіти |
| `packages/contracts` | zod-схеми запитів, моделі відповідей, таблиця маршрутів, політика помилок |
| `apps/api` | Express: Repository + Unit of Work, сервіси, маршрути з контракту, Swagger |
| `apps/web` | React SPA (Mantine, TanStack Query, react-hook-form) |
| `apps/e2e` | Playwright-смоук на реальному стеку (Лаб 1 і Лаб 2) |

## Перевірки

```bash
pnpm db:reset && pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm --filter @clinic/api check:sql-access   # API працює лише через v_* / fn_* / CALL sp_*
pnpm e2e                                     # Playwright: сам запускає API і UI, якщо вони не запущені
pnpm --filter @clinic/db catalog             # кількість таблиць / функцій / тригерів / view / індексів
pnpm --filter @clinic/db explain             # перегенерувати reports/explain.md
```

## Документація

- [Вимоги](docs/01-requirements.md) · [SQL-об'єкти](docs/02-sql-objects.md) · [Архітектура](docs/03-architecture.md)
- [**Звіт до лабораторної**](docs/04-report.md): вимога → файл → як перевірити, каталог, індекси, аудит, UoW, ER-діаграма, знімки
- [Рішення та відхилення](docs/05-decisions.md)
- Лаб 2: [огляд NoSQL, аргументація, вимоги, моделі](docs/06-nosql-requirements.md) · [**звіт до лабораторної 2**](docs/07-nosql-report.md): відповідність завданню, дані, методика, результати, еквівалентність, загрози валідності
