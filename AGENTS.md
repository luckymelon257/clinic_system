# AGENTS.md — standing rules for every agent in this repo

Hospital Management System (university DB lab). Specs: `docs/01-requirements.md`, `docs/02-sql-objects.md`,
`docs/03-architecture.md` (Ukrainian, approved — do not re-open). Ambiguities / invalid-PG spots: pick the closest
correct option and append a line to `docs/05-decisions.md`.

## Layout
| Package | Name | Owner |
|---|---|---|
| `packages/contracts` | `@clinic/contracts` | orchestrator (seam between api and web) |
| `packages/db` + `docker-compose.yml` | `@clinic/db` | Agent 1 (Infra + DB) |
| `apps/api` | `@clinic/api` | Agent 2 (Backend) |
| `apps/web` | `@clinic/web` | Agent 3 (Frontend) |
| `apps/e2e` | `@clinic/e2e` | orchestrator |

Lab 2 (NoSQL) adds packages below. Spec: `docs/06-nosql-requirements.md`.
| Package | Name | Owner |
|---|---|---|
| `packages/graph` | `@clinic/graph` | `gen/`, `validate.ts`: W1 graph-sql · `neo4j/`, `sync/`, `package.json`: W1 graph-neo4j |
| `packages/redis` | `@clinic/redis` | W1 redis |
| `packages/bench` | `@clinic/bench` | core + report: orchestrator · `scenarios/redis`: W1 redis · `scenarios/graph`, `equivalence`: W2 graph-bench |
| `docker-compose.yml`, root `package.json`, `@clinic/contracts`, migration numbering | — | orchestrator (009 = W0, 010 = graph-sql, 011 = redis, 012+ ask) |

Stack: PostgreSQL 16, Node 20+/22, Express + TypeScript + `pg` (no ORM), React + Vite + TS, pnpm workspaces + Turborepo.
`@clinic/contracts` ships TypeScript source (no build step); consumers compile it.

## Rules
1. **Stay in your package.** Touch only files you own. Need something elsewhere → report it, don't edit it.
2. **App code never touches base tables.** `apps/api` reads only from `v_*` views / `fn_*` functions and writes only via
   `CALL sp_*`. No `INSERT INTO`, `UPDATE <table>`, `DELETE FROM`, `FROM <table>` in `apps/api/src` (`check:sql-access` enforces it).
3. **Every write goes through a Unit of Work** (`UnitOfWork.run(userId, async uow => …)`): one client, `BEGIN`,
   `set_config('app.current_user_id', …, true)`, commit / rollback.
4. **The contract is additive-only during a wave.** Never rename or remove a route key, path, field or enum label in
   `@clinic/contracts`. Additions only, and list them in your report.
5. **Gates pasted before "done".** Never claim green without the command output.
6. **Small per-phase commits.** Message is ONE line, Conventional Commits: `feat: …`, `fix: …`, `chore: …`, `test: …`,
   `docs: …`. No body, no `Co-Authored-By` trailer, no other authors — commit as the configured git user.
7. **Sub-agents never push.** Nobody pushes; there is no remote work in this project.

## Local environment
- Postgres: `docker compose up -d db` → `localhost:5434`, user/password `clinic`/`clinic`. Do not start containers outside `docker-compose.yml`.
- Neo4j 5.26 Community (one DB per instance): `neo4j` → HTTP `7475`, Bolt `7688`; `neo4j-test` (profile `test`, tmpfs) → HTTP `7476`,
  Bolt `7689`. User/password `neo4j`/`clinicneo4j`.
- Redis 7.4: `localhost:6380`. Every key **and pub/sub channel** is prefixed with `REDIS_PREFIX` (channels ignore the DB index).
- Each agent uses its own databases so parallel work never collides:
  - main / grader: `clinic`
  - Agent 1: `clinic_db_dev`, tests `clinic_db_test`
  - Agent 2: `clinic_api_dev`, tests `clinic_api_test`
- Lab 2 resources (PG databases · Neo4j · Redis DB index / prefix):
  | Agent | PG | Neo4j | Redis |
  |---|---|---|---|
  | orchestrator / grader | `clinic`, `clinic_bench_x1/x5/x10` | `neo4j` | 0 / `clinic` |
  | W1 graph-sql | `clinic_graph_dev`, `clinic_graph_test` | — | — |
  | W1 graph-neo4j | `clinic_neo_dev`, `clinic_neo_test` | `neo4j-test` | — |
  | W1 redis | `clinic_redis_dev`, `clinic_redis_test` | — | 1 / `w1redis`; tests 2 / random prefix |
  | W2 graph-bench | `clinic_bench_x1/x5/x10` | `neo4j` | 5 / `bench` |
  | W2 api | `clinic_api_dev`, `clinic_api_test` | `neo4j-test` | 3 / `api`; tests 4 / random prefix |
  | W2 web | — (MSW) | — | — |
- Ports: API `4000`, web `5173`, PG `5434`, Neo4j `7475`/`7688` (test `7476`/`7689`), Redis `6380`.
  (5432/5433/3000 are taken on this machine by unrelated projects.)
- Demo users (password = role name + `123`): `admin@clinic.local`, `registrar@clinic.local`, `doctor@clinic.local`,
  `lab@clinic.local` (lab_technician), `cashier@clinic.local`, `patient@clinic.local`.
- Root scripts: `build dev lint typecheck test db:up db:migrate db:seed db:reset e2e`; Lab 2: `nosql:up` (db + neo4j + redis),
  `graph:sync` (`--full` ETL / `--follow` outbox worker), `bench`, `bench:report`, `simulate` (ICU vitals → Redis Stream). Every package has `typecheck`, `lint`, `test`.

## Conventions
- DB: snake_case; API/UI: camelCase (mapping in the repository layer).
- `timestamptz` → ISO string, `date` → `'YYYY-MM-DD'` string, `numeric` → number.
- Business errors: `RAISE EXCEPTION '<Ukrainian message>' USING ERRCODE = 'P0xxx'`. `P0002` = not found (404),
  `P0403` = forbidden, `P0409` = conflict; other `P0xxx` → 422. See `packages/contracts/src/errors.ts`.
- Working notes go to `.agent/` (git-ignored, never committed).
