import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { databaseUrl } from './index';

// Writes reports/explain.md: EXPLAIN (ANALYZE, BUFFERS) for every index type, without the index
// (BEGIN; DROP …; EXPLAIN; ROLLBACK) and with it. Run against a database reset WITH volume data.

interface Case {
  type: string;
  index: string;
  why: string;
  drop: string[]; // statements that remove the index inside the "before" transaction
  query: string;
}

const url = databaseUrl();
const client = new pg.Client({ connectionString: url });
await client.connect();

const scalar = async (sql: string) => String(Object.values((await client.query(sql)).rows[0] ?? {})[0]);

// Literals picked from the data so every query hits real rows.
const invoiceNumber = await scalar('SELECT number FROM invoices ORDER BY id OFFSET 15000 LIMIT 1');
const patientEmail = await scalar("SELECT email FROM patients WHERE email LIKE 'p%@mail.example' ORDER BY id OFFSET 5000 LIMIT 1");
const busyPatient = await scalar(
  'SELECT patient_id FROM appointments GROUP BY patient_id ORDER BY count(*) DESC, patient_id LIMIT 1',
);
const auditPatient = await scalar("SELECT id FROM patients WHERE phone::text LIKE '+38063%' ORDER BY id OFFSET 4321 LIMIT 1");

const cases: Case[] = [
  {
    type: 'B-tree (composite)',
    index: 'ix_appointments_doctor_start ON appointments (doctor_id, starts_at)',
    why: 'Розклад лікаря за період (діапазонний запит по другому стовпцю).',
    drop: ['DROP INDEX ix_appointments_doctor_start', 'DROP INDEX ix_appointments_starts_at'],
    query: `SELECT id, starts_at, status FROM appointments
WHERE doctor_id = 4 AND starts_at >= current_date - 60 AND starts_at < current_date - 53
ORDER BY starts_at`,
  },
  {
    type: 'Unique',
    index: 'ux_invoices_number ON invoices (number) — UNIQUE constraint',
    why: 'Пошук рахунку за номером; цілісність номерів.',
    drop: ['ALTER TABLE invoices DROP CONSTRAINT ux_invoices_number'],
    query: `SELECT id, status, total_due FROM invoices WHERE number = '${invoiceNumber}'`,
  },
  {
    type: 'Partial',
    index: "ix_invoices_unpaid ON invoices (due_date) WHERE status IN ('issued', 'partially_paid')",
    why: 'Прострочені рахунки: індексуються лише неоплачені рядки (малий індекс).',
    drop: ['DROP INDEX ix_invoices_unpaid'],
    query: `SELECT id, number, due_date FROM invoices
WHERE status IN ('issued', 'partially_paid') AND due_date < current_date
ORDER BY due_date`,
  },
  {
    type: 'Expression',
    index: 'ix_patients_email_lower ON patients (lower(email))',
    why: 'Пошук пацієнта за email без урахування регістру.',
    drop: ['DROP INDEX ix_patients_email_lower'],
    query: `SELECT id, last_name, first_name FROM patients WHERE lower(email) = lower('${patientEmail.toUpperCase()}')`,
  },
  {
    type: 'GIN (pg_trgm)',
    index: "ix_patients_fullname_trgm ON patients USING gin ((last_name || ' ' || first_name) gin_trgm_ops)",
    why: "Нечіткий пошук ILIKE '%…%' (fn_search_patients).",
    drop: ['DROP INDEX ix_patients_fullname_trgm'],
    query: `SELECT id, last_name, first_name FROM patients
WHERE (last_name || ' ' || first_name) ILIKE '%ченко Окс%'`,
  },
  {
    type: 'GIN (jsonb_path_ops)',
    index: 'ix_audit_new_data ON audit_log USING gin (new_data jsonb_path_ops)',
    why: 'Пошук у журналі аудиту за значенням поля (оператор @>).',
    drop: ['DROP INDEX ix_audit_new_data'],
    query: `SELECT id, table_name, record_id, operation, changed_at FROM audit_log
WHERE new_data @> '{"patient_id": ${auditPatient}}'`,
  },
  {
    type: 'GiST (EXCLUDE)',
    index: 'ex_appointments_doctor_overlap EXCLUDE USING gist (doctor_id WITH =, tstzrange(starts_at, ends_at) WITH &&)',
    why: 'BR-1: перевірка перетину інтервалів (так само шукає fn_is_doctor_available).',
    drop: ['ALTER TABLE appointments DROP CONSTRAINT ex_appointments_doctor_overlap'],
    query: `SELECT id, starts_at, ends_at FROM appointments
WHERE doctor_id = 4 AND status NOT IN ('cancelled', 'no_show')
  AND tstzrange(starts_at, ends_at) && tstzrange((current_date - 100) + time '10:00', (current_date - 100) + time '12:00')`,
  },
  {
    type: 'BRIN',
    index: 'ix_payments_paid_at ON payments USING brin (paid_at)',
    why: 'Хронологічна таблиця оплат: діапазон дат, індекс займає кілька сторінок.',
    drop: ['DROP INDEX ix_payments_paid_at'],
    query: `SELECT count(*), sum(amount) FROM payments
WHERE paid_at >= current_date - 400 AND paid_at < current_date - 370`,
  },
  {
    type: 'Covering (INCLUDE)',
    index: 'ix_appointments_patient ON appointments (patient_id) INCLUDE (starts_at, status)',
    why: 'Історія прийомів пацієнта: Index Only Scan без звернення до таблиці.',
    drop: ['DROP INDEX ix_appointments_patient'],
    query: `SELECT starts_at, status FROM appointments WHERE patient_id = ${busyPatient} ORDER BY starts_at`,
  },
];

const explain = async (q: string) =>
  (await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${q}`)).rows.map((r) => r['QUERY PLAN'] as string).join('\n');
const execMs = (plan: string) => Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? NaN);

const counts = (
  await client.query<{ t: string; n: number }>(`
    SELECT 'patients' t, count(*)::int n FROM patients UNION ALL
    SELECT 'appointments', count(*)::int FROM appointments UNION ALL
    SELECT 'invoices', count(*)::int FROM invoices UNION ALL
    SELECT 'payments', count(*)::int FROM payments UNION ALL
    SELECT 'audit_log', count(*)::int FROM audit_log`)
).rows;

const sections: string[] = [];
const summary: string[] = [];
for (const c of cases) {
  await explain(c.query); // warm-up so before/after compare equally cached data
  await client.query('BEGIN');
  for (const d of c.drop) await client.query(d);
  const before = await explain(c.query);
  await client.query('ROLLBACK');
  const after = await explain(c.query);
  const b = execMs(before);
  const a = execMs(after);
  summary.push(`| ${c.type} | \`${c.index.split(' ')[0]}\` | ${b.toFixed(3)} | ${a.toFixed(3)} | ${(b / a).toFixed(1)}× |`);
  sections.push(`## ${c.type}

**Індекс:** \`${c.index}\`
${c.why}

\`\`\`sql
${c.query};
\`\`\`

**До** (у транзакції: \`${c.drop.join('; ')}\` → EXPLAIN → ROLLBACK):

\`\`\`
${before}
\`\`\`

**Після** (з індексом):

\`\`\`
${after}
\`\`\`
`);
}

await client.end();

const report = `# EXPLAIN (ANALYZE, BUFFERS): до / після індексів

Згенеровано скриптом \`pnpm --filter @clinic/db explain\` ${new Date().toISOString()} на базі \`${new URL(url).pathname.slice(1)}\`
(\`reset\` з volume-даними, після \`VACUUM ANALYZE\`). Вивід — реальний, без редагування.

Обсяг: ${counts.map((r) => `${r.t} = ${r.n}`).join(', ')}.

| Тип індексу | Індекс | До, ms | Після, ms | Прискорення |
|---|---|---:|---:|---:|
${summary.join('\n')}

${sections.join('\n')}`;

const out = fileURLToPath(new URL('../reports/explain.md', import.meta.url));
mkdirSync(new URL('../reports', import.meta.url), { recursive: true });
writeFileSync(out, report);
console.log(`written ${out}`);
console.log(summary.join('\n'));
