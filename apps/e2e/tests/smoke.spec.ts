import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

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


// One patient walks through the whole clinic: booking → visit → payment → soft delete → restore.
test.describe.serial('real stack smoke', () => {
  const lastName = `Плейрайтенко${Array.from({ length: 5 }, () => 'абвгдежзклмнопрстуф'[Math.floor(Math.random() * 19)]).join('')}`;
  let patientId = 0;
  let appointmentId = 0;
  let invoiceId = 0;

  test.beforeAll(async ({ request }) => {
    const t = await token(request, 'registrar@clinic.local', 'registrar123');
    const res = await request.post(`${API}/api/patients`, {
      headers: { authorization: `Bearer ${t}` },
      data: { lastName, firstName: 'Тест', middleName: 'Едвардович', birthDate: '1990-05-17', sex: 'male', phone: '+380501112233' },
    });
    expect(res.status()).toBe(201);
    patientId = ((await res.json()) as { id: number }).id;
  });

  test('registrar books an appointment', async ({ page }) => {
    await login(page, 'registrar@clinic.local', 'registrar123');
    await page.screenshot({ path: `${SHOTS}/01-dashboard-registrar.png`, fullPage: true });
    await page.goto(`/booking?patientId=${patientId}`);
    await expect(page.getByLabel('Пацієнт', { exact: true })).toHaveValue(String(patientId));
    const doctor = page.getByLabel('Лікар', { exact: true });
    await doctor.selectOption({ label: (await doctor.locator('option', { hasText: 'Коваленко Олена Петрівна' }).textContent())! });

    // first day (from tomorrow) with a free slot
    const slot = page.getByRole('button', { name: /^\d{2}:\d{2}$/ }).first();
    for (let d = 1; d <= 14; d++) {
      await page.getByLabel('Дата').fill(new Date(Date.now() + d * 86_400_000).toLocaleDateString('sv-SE'));
      await expect(page.getByText(/Завантаження слотів/)).toHaveCount(0);
      if (await slot.isVisible()) break;
    }
    await slot.click();
    await page.getByLabel('Причина звернення').fill('Кашель, температура');
    await page.screenshot({ path: `${SHOTS}/02-booking.png`, fullPage: true });
    await page.getByRole('button', { name: 'Записати' }).click();
    const ok = page.getByText(/Запис №\d+/);
    await expect(ok).toBeVisible();
    appointmentId = Number((await ok.textContent())!.match(/№(\d+)/)![1]);
  });

  test('doctor completes the visit', async ({ page }) => {
    await login(page, 'doctor@clinic.local', 'doctor123');
    await page.goto('/doctor');
    await page.screenshot({ path: `${SHOTS}/03-doctor-day.png`, fullPage: true });
    await page.goto(`/visit/${appointmentId}`);
    await expect(page.getByRole('heading', { name: new RegExp(`Прийом: ${lastName}`) })).toBeVisible();
    await page.getByLabel('Скарги').fill('Кашель 3 дні, t 37.8');
    await page.getByLabel('Огляд').fill('Гіперемія зіву, дихання везикулярне');
    await page.getByLabel(/Висновок/).fill('Гостра респіраторна інфекція');
    await page.getByLabel('Пошук МКХ-10').fill('J06');
    await page.getByRole('button', { name: /J06\.9/ }).click();
    await page.getByLabel('Пошук препарату').fill('Парацетамол');
    await page.getByRole('button', { name: /Парацетамол/ }).first().click();
    await page.getByLabel('Дозування').fill('500 мг');
    await page.getByLabel('Частота').fill('3 рази на день');
    await page.getByLabel('Днів').fill('5');
    await page.getByLabel('К-сть').fill('15');
    await page.getByLabel(/\(HGB\)/).check();
    await page.screenshot({ path: `${SHOTS}/04-visit-form.png`, fullPage: true });
    await page.getByRole('button', { name: 'Завершити прийом' }).click();
    await expect(page.getByText('Прийом завершено')).toBeVisible();
    const inv = page.getByText(/Рахунок: №\d+/);
    invoiceId = Number((await inv.textContent())!.match(/№(\d+)/)![1]);
    await expect(page.getByText(/Рецепт: №\d+/)).toBeVisible();
    await expect(page.getByText(/Направлення на аналізи: №\d+/)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/05-visit-done.png`, fullPage: true });
  });

  test('cashier takes a payment', async ({ page, request }) => {
    const t = await token(request, 'cashier@clinic.local', 'cashier123');
    const inv = (await (await request.get(`${API}/api/invoices/${invoiceId}`, { headers: { authorization: `Bearer ${t}` } })).json()) as { balance: number };
    expect(inv.balance).toBeGreaterThan(1);

    await login(page, 'cashier@clinic.local', 'cashier123');
    await page.goto(`/invoices/${invoiceId}`);
    // partial payment first (F-31), then the rest
    await page.getByLabel('Сума, грн').fill('1');
    await page.getByLabel('Спосіб').selectOption('cash');
    await page.getByRole('button', { name: 'Зареєструвати оплату' }).click();
    await expect(page.getByText('Частково оплачено').first()).toBeVisible();
    await page.getByLabel('Сума, грн').fill((inv.balance - 1).toFixed(2));
    await page.getByLabel('Спосіб').selectOption('card');
    await page.getByRole('button', { name: 'Зареєструвати оплату' }).click();
    await expect(page.getByText('Оплачено', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/06-invoice-paid.png`, fullPage: true });
    await page.goto('/revenue');
    await page.getByRole('button', { name: /Оновити/ }).click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${SHOTS}/07-revenue.png`, fullPage: true });
  });

  test('admin sees audit entries and restores a soft-deleted patient', async ({ page }) => {
    await login(page, 'admin@clinic.local', 'admin123');
    await page.goto(`/patients/${patientId}`);
    await expect(page.getByRole('heading', { name: new RegExp(lastName) })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/08-patient-card.png`, fullPage: true });
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Видалити' }).click();

    await page.goto('/deleted');
    const row = page.getByRole('row', { name: new RegExp(lastName) });
    await expect(row).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/09-deleted.png`, fullPage: true });
    await row.getByRole('button', { name: 'Відновити' }).click();
    await expect(row).toHaveCount(0);

    await page.goto('/audit');
    await page.getByLabel('Таблиця').fill('patients');
    await page.getByLabel('ID запису').fill(String(patientId));
    for (const op of ['INSERT', 'SOFT_DELETE', 'RESTORE']) await expect(page.getByRole('cell', { name: op, exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'admin@clinic.local' }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'registrar@clinic.local' }).first()).toBeVisible();
    await page.getByRole('cell', { name: 'SOFT_DELETE', exact: true }).click();
    await page.screenshot({ path: `${SHOTS}/10-audit.png`, fullPage: true });

    await page.goto(`/patients/${patientId}`);
    await expect(page.getByRole('heading', { name: new RegExp(lastName) })).toBeVisible();
    await page.goto('/inpatient');
    await page.screenshot({ path: `${SHOTS}/11-inpatient.png`, fullPage: true });
    await page.goto('/lab');
    await page.screenshot({ path: `${SHOTS}/12-lab.png`, fullPage: true });
  });
});
