# CONTRIBUTING.md — development rules for this repo

Hospital Management System (university DB lab). Specs: `docs/01-requirements.md`, `docs/02-sql-objects.md`,
`docs/03-architecture.md` (Ukrainian, approved — do not re-open). Ambiguities / invalid-PG spots: pick the closest
correct option and append a line to `docs/05-decisions.md`.

## Layout
| Package | Name | Owner |
|---|---|---|
| `packages/contracts` | `@clinic/contracts` | shared (seam between api and web) |
| `packages/db` + `docker-compose.yml` | `@clinic/db` | Infra + DB |
| `apps/api` | `@clinic/api` | Backend |
| `apps/web` | `@clinic/web` | Frontend |

Stack: PostgreSQL 16, Node 20+/22, Express + TypeScript + `pg` (no ORM), React + Vite + TS, pnpm workspaces + Turborepo.
`@clinic/contracts` ships TypeScript source (no build step); consumers compile it.

## Rules
1. **Stay in the package you are changing.** A change elsewhere goes in its own commit.
2. **App code never touches base tables.** `apps/api` reads only from `v_*` views / `fn_*` functions and writes only via
   `CALL sp_*`. No `INSERT INTO`, `UPDATE <table>`, `DELETE FROM`, `FROM <table>` in `apps/api/src` (`check:sql-access` enforces it).
3. **Every write goes through a Unit of Work** (`UnitOfWork.run(userId, async uow => …)`): one client, `BEGIN`,
   `set_config('app.current_user_id', …, true)`, commit / rollback.
4. **The contract is additive-only within a lab.** Never rename or remove a route key, path, field or enum label in
   `@clinic/contracts`. Additions only, and list them in the report.
5. **Gates pasted before "done".** Never claim green without the command output.
6. **Small per-phase commits.** Message is ONE line, Conventional Commits: `feat: …`, `fix: …`, `chore: …`, `test: …`,
   `docs: …`. No body, no trailers.
7. **Never push to `main`.** Lab work stays on its branch until it is reviewed.

## Local environment
- Postgres: `docker compose up -d db` → `localhost:5434`, user/password `clinic`/`clinic`. Do not start another container.
- Each workstream uses its own databases so parallel work never collides:
  - main / grader: `clinic`
  - db package: `clinic_db_dev`, tests `clinic_db_test`
  - api package: `clinic_api_dev`, tests `clinic_api_test`
- Ports: API `4000`, web `5173`. (5432/5433/3000 are taken on this machine by unrelated projects.)
- Demo users (password = role name + `123`): `admin@clinic.local`, `registrar@clinic.local`, `doctor@clinic.local`,
  `lab@clinic.local` (lab_technician), `cashier@clinic.local`, `patient@clinic.local`.
- Root scripts: `build dev lint typecheck test db:up db:migrate db:seed db:reset`. Every package has `typecheck`, `lint`, `test`.

## Conventions
- DB: snake_case; API/UI: camelCase (mapping in the repository layer).
- `timestamptz` → ISO string, `date` → `'YYYY-MM-DD'` string, `numeric` → number.
- Business errors: `RAISE EXCEPTION '<Ukrainian message>' USING ERRCODE = 'P0xxx'`. `P0002` = not found (404),
  `P0403` = forbidden, `P0409` = conflict; other `P0xxx` → 422. See `packages/contracts/src/errors.ts`.
- Working notes go to `.notes/` (git-ignored, never committed).
