import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppRoutes, Providers } from './App';
import { setToken } from './api';
import { addDays, localDate } from './mocks/db';
import { server } from './test-setup';

const renderAt = (path: string, token?: string) => {
  if (token) setToken(token);
  return render(
    <Providers>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </Providers>,
  );
};

// demo tokens issued by the mock login: mock-token-<userId> (2 = registrar, 3 = doctor)
describe('web smoke (MSW)', () => {
  it('login: wrong password shows the API error, right one lands on the dashboard', async () => {
    const user = userEvent.setup();
    renderAt('/login');
    await user.type(screen.getByLabelText('Email'), 'doctor@clinic.local');
    await user.type(screen.getByLabelText('Пароль'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Увійти' }));
    expect(await screen.findByText('Невірний email або пароль')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Пароль'));
    await user.type(screen.getByLabelText('Пароль'), 'doctor123');
    await user.click(screen.getByRole('button', { name: 'Увійти' }));
    expect(await screen.findByText('Вітаємо, Іваненко Олег Петрович')).toBeInTheDocument();
    expect(await screen.findByText(/Мої прийоми сьогодні/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Прийоми лікаря' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Журнал аудиту' })).not.toBeInTheDocument();
  });

  it('booking: pick patient, doctor, date and a free slot → appointment created', async () => {
    const user = userEvent.setup();
    renderAt('/booking', 'mock-token-2');
    await screen.findByRole('option', { name: /Шевченко Тарас/ });
    await user.selectOptions(screen.getByLabelText('Пацієнт'), '1');
    await screen.findByRole('option', { name: /Іваненко Олег/ });
    await user.selectOptions(screen.getByLabelText('Лікар'), '1');

    let monday = addDays(localDate(), 1);
    while (new Date(`${monday}T12:00:00`).getDay() !== 1) monday = addDays(monday, 1);
    fireEvent.change(screen.getByLabelText('Дата'), { target: { value: monday } });

    const slots = await screen.findAllByRole('button', { name: /^\d{2}:\d{2}$/ });
    await user.click(slots[0]!);
    await user.type(screen.getByLabelText('Причина звернення'), 'Консультація');
    await user.click(screen.getByRole('button', { name: 'Записати' }));
    expect(await screen.findByText('Запис створено')).toBeInTheDocument();
  });

  it('visit: fill record + diagnosis + lab order → completeVisit called, result ids shown', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST') calls.push(new URL(request.url).pathname);
    });
    renderAt('/doctor', 'mock-token-3');
    const row = (await screen.findByText(/Шевченко Тарас/)).closest('tr')!;
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Почати прийом' }));
    await screen.findByText(/Прийом: Шевченко Тарас/);

    // contract validation (exactly one primary / at least one diagnosis) runs client-side
    await user.click(screen.getByRole('button', { name: 'Завершити прийом' }));
    expect(await screen.findByText('Хоча б один діагноз')).toBeInTheDocument();
    expect(calls.some((c) => c.endsWith('/complete'))).toBe(false);

    await user.type(screen.getByLabelText('Скарги'), 'Кашель');
    await user.type(screen.getByLabelText(/Висновок/), 'ГРВІ, одужання');
    await user.type(screen.getByLabelText('Пошук МКХ-10'), 'J06');
    await user.click(await screen.findByRole('button', { name: /J06\.9/ }));
    await user.click(await screen.findByLabelText('Гемоглобін (HGB)'));
    await user.click(screen.getByRole('button', { name: 'Завершити прийом' }));

    expect(await screen.findByText('Прийом завершено')).toBeInTheDocument();
    expect(screen.getByText(/Медичний запис №\d+/)).toBeInTheDocument();
    expect(screen.getByText(/Направлення на аналізи: №\d+/)).toBeInTheDocument();
    expect(screen.getByText(/Рахунок: №\d+/)).toBeInTheDocument();
    expect(calls).toContain('/api/visits/3/complete');
  });
});

describe('every page renders on mock data (admin)', () => {
  it.each([
    ['/', 'Заповненість стаціонару'],
    ['/patients', 'Ковальчук Олена Миколаївна'],
    ['/patients/2', 'Останні зміни: registrar@clinic.local'],
    ['/registration', 'Реєстрація пацієнта'],
    ['/doctor', 'Прийоми на сьогодні'],
    ['/lab', 'С-реактивний білок (CRP)'],
    ['/inpatient', 'Палата 101 (загальна, 600 грн/доба)'],
    ['/invoices', 'INV-'],
    ['/invoices/2', 'Рахунок прострочено'],
    ['/revenue', 'Виручка по місяцях'],
    ['/audit', 'phone, address'],
    ['/deleted', 'Гнатюк Василь Петрович (#8)'],
  ])('%s', async (path, text) => {
    renderAt(path, 'mock-token-1');
    expect((await screen.findAllByText((_, el) => !el?.children.length && !!el?.textContent?.includes(text)))[0]).toBeInTheDocument();
    expect(screen.queryByText('Помилка')).not.toBeInTheDocument();
  });

  it('lab technician cannot open finance pages', async () => {
    renderAt('/invoices', 'mock-token-4');
    expect(await screen.findByText('Недостатньо прав')).toBeInTheDocument();
  });
});
