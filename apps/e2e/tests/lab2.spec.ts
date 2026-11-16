import { connectRedis, disconnectRedis, ingestVitals, redisConfigFromEnv } from '@clinic/redis';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Lab 2 on the real stack: API (Neo4j + Redis wired) + web. Prerequisites (README / docs/07):
//   pnpm db:reset && pnpm graph:sync --full     (Neo4j holds the `clinic` database; NEO4J_URL for the API)
// The API process uses the same REDIS_URL / REDIS_PREFIX as this test (defaults: DB 0, prefix `clinic`).

const API = 'http://localhost:4000';
const SHOTS = '../../docs/screenshots';

async function token(request: APIRequestContext, email: string, password: string) {
  const res = await request.post(`${API}/api/auth/login`, { data: { email, password } });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { token: string }).token;
}

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Увійти' }).click();
  await expect(page.getByText(/Вітаємо/)).toBeVisible();
}

test.describe.serial('lab 2 real stack', () => {
  test('tracing page renders the contact graph of a nurse (Neo4j)', async ({ page }) => {
    await login(page, 'doctor@clinic.local', 'doctor123');
    await page.goto('/tracing');
    await page.getByText('Персонал').first().click();
    await page.getByLabel('ID співробітника').first().fill('13'); // first nurse of the 04 seed: shifts in the last 28 days
    await page.getByRole('button', { name: 'Трасувати' }).click();
    await expect(page.getByTestId('trace-result')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('trace-graph').locator('canvas').first()).toBeVisible();
    await expect(page.getByTestId('graph-freshness')).toContainText(/відставання/);
    const rows = page.getByTestId('trace-table').locator('tbody tr');
    expect(await rows.count()).toBeGreaterThan(0);
    await page.getByTestId('trace-result').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/13-tracing.png` });
  });

  test('ICU monitor shows a live critical alert from the Redis stream', async ({ page, request }) => {
    const t = await token(request, 'doctor@clinic.local', 'doctor123');
    const beds = (await (await request.get(`${API}/api/icu/beds`, { headers: { authorization: `Bearer ${t}` } })).json()) as { bedId: number }[];
    expect(beds.length).toBeGreaterThan(0);
    await login(page, 'doctor@clinic.local', 'doctor123');
    await page.goto('/icu');
    await expect(page.getByTestId('stream-state')).toContainText('наживо', { timeout: 15_000 });
    const ctx = await connectRedis(redisConfigFromEnv());
    try {
      // SpO2 81 % (< 88) and HR 152 (> 140) — two BR-17 violations in one reading
      await ingestVitals(ctx, { bedId: beds[0]!.bedId, hr: 152, spo2: 81, sbp: 118, dbp: 72, rr: 18, temp: 36.8 });
    } finally {
      await disconnectRedis(ctx);
    }
    await expect(page.getByTestId('icu-alerts')).toContainText(/spo2|SpO/i, { timeout: 5_000 });
    await page.screenshot({ path: `${SHOTS}/14-icu.png`, fullPage: true });
  });

  test('triage pops arrivals in ESI order, then arrival order', async ({ page, request }) => {
    const t = await token(request, 'registrar@clinic.local', 'registrar123');
    const h = { authorization: `Bearer ${t}` };
    // drain whatever earlier runs left
    for (let k = 0; k < 200; k++) {
      const r = (await (await request.post(`${API}/api/triage/next`, { headers: h })).json()) as { entry: unknown };
      if (!r.entry) break;
    }
    const tag = Date.now().toString(36);
    for (const [name, esi] of [[`Пізній-ESI3-${tag}`, 3], [`Критичний-ESI1-${tag}`, 1], [`Ранній-ESI3-${tag}`, 3]] as const) {
      expect((await request.post(`${API}/api/triage`, { headers: h, data: { patientName: name, esi, complaint: 'e2e' } })).status()).toBe(201);
    }
    await login(page, 'registrar@clinic.local', 'registrar123');
    await page.goto('/triage');
    await expect(page.getByTestId('triage-queue')).toContainText(`Критичний-ESI1-${tag}`);
    await page.screenshot({ path: `${SHOTS}/15-triage.png`, fullPage: true });
    const order: string[] = [];
    for (let k = 0; k < 3; k++) {
      await page.getByRole('button', { name: /Викликати наступного/ }).click();
      const called = page.getByTestId('triage-called');
      await expect(called).toBeVisible();
      order.push((await called.textContent()) ?? '');
      await called.getByRole('button').first().click(); // close
    }
    expect(order[0]).toContain(`Критичний-ESI1-${tag}`);
    expect(order[1]).toContain(`Пізній-ESI3-${tag}`); // added before "Ранній" → arrived first
    expect(order[2]).toContain(`Ранній-ESI3-${tag}`);
  });
});
