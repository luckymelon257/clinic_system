# clinic_system

Система управління лікарнею: PostgreSQL 16 + Express/TypeScript (`pg`, без ORM) + React/Vite. Монорепо pnpm + Turborepo.

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

## Структура

| Пакет | Що всередині |
|---|---|
| `packages/db` | SQL-міграції `001…008`, seed-и, SQL-тести, `reports/explain.md`, [`SQL_API.md`](packages/db/SQL_API.md) |
| `packages/contracts` | zod-схеми запитів, моделі відповідей, таблиця маршрутів, політика помилок |
| `apps/api` | Express: Repository + Unit of Work, сервіси, маршрути з контракту, Swagger |
| `apps/web` | React SPA (Mantine, TanStack Query, react-hook-form) |
| `apps/e2e` | Playwright-смоук на реальному стеку |

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
