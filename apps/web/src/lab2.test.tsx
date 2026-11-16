import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppRoutes, Providers } from './App';
import { setToken } from './api';
import { createSseParser } from './sse';
import { server } from './test-setup';

const renderAt = (path: string, token: string) => {
  setToken(token);
  return render(
    <Providers>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </Providers>,
  );
};

// mock tokens: 1 admin, 2 registrar, 3 doctor (doctorId 1)
describe('SSE parser (fetch-based /api/icu/stream)', () => {
  it('handles chunk boundaries anywhere, multi-line data, CRLF, comments and pings', () => {
    const got: string[] = [];
    const p = createSseParser((d) => got.push(d));
    const wire = 'data: {"type":"ping",\r\ndata: "at":"x"}\r\n\r\n: keep-alive\n\ndata: {"a":1}\n\ndata:{"b":2}\n\n';
    for (const ch of wire) p.push(ch); // one character per chunk = worst case
    expect(got).toEqual(['{"type":"ping",\n"at":"x"}', '{"a":1}', '{"b":2}']);
    const got2: string[] = [];
    const p2 = createSseParser((d) => got2.push(d));
    p2.push('data: {"x"');
    p2.push(':1}\n');
    expect(got2).toEqual([]); // event not finished until the blank line
    p2.push('\n');
    expect(got2).toEqual(['{"x":1}']);
  });
});

describe('Lab 2 pages (MSW)', () => {
  it('tracing: index patient → graph container + contact table sorted by hops, freshness shown', async () => {
    const user = userEvent.setup();
    renderAt('/tracing', 'mock-token-3');
    await screen.findAllByRole('option', { name: /Лисенко Микола/ });
    await user.selectOptions(screen.getAllByRole('combobox', { name: 'Пацієнт' })[0]!, '7');
    await user.click(screen.getByRole('button', { name: 'Трасувати' }));
    const table = await screen.findByTestId('trace-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    const hops = rows.map((r) => Number(within(r).getAllByRole('cell')[0]!.textContent));
    expect(hops).toEqual([...hops].sort((a, b) => a - b));
    expect(within(table).getByText('Шевченко Тарас Григорович')).toBeInTheDocument(); // shared room → 1 hop
    expect(screen.getByTestId('trace-graph')).toHaveAttribute('data-nodes', String(rows.length + 1));
    expect(screen.getByTestId('graph-freshness')).toHaveTextContent(/відставання 120 мс/);

    await user.click(screen.getByRole('button', { name: 'Сортувати за кроками' }));
    const desc = within(screen.getByTestId('trace-table')).getAllByRole('row').slice(1).map((r) => Number(within(r).getAllByRole('cell')[0]!.textContent));
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
  });

  it('tracing: 503 GRAPH_UNAVAILABLE shows a clear message', async () => {
    server.use(http.get('*/api/graph/trace', () => HttpResponse.json({ error: { code: 'GRAPH_UNAVAILABLE', message: 'Neo4j недоступний' } }, { status: 503 })));
    const user = userEvent.setup();
    renderAt('/tracing', 'mock-token-3');
    await screen.findAllByRole('option', { name: /Лисенко Микола/ });
    await user.selectOptions(screen.getAllByRole('combobox', { name: 'Пацієнт' })[0]!, '7');
    await user.click(screen.getByRole('button', { name: 'Трасувати' }));
    expect(await screen.findByTestId('graph-unavailable')).toHaveTextContent('Графова база недоступна');
  });

  it('triage: queue is ESI-then-arrival ordered, a new ESI 1 goes first, call-next pops it', async () => {
    const user = userEvent.setup();
    renderAt('/triage', 'mock-token-2');
    const names = async () => within(await screen.findByTestId('triage-queue')).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[2]!.textContent);
    await screen.findByText('Невідомий чоловік');
    expect(await names()).toEqual(['Невідомий чоловік', 'Бойко Андрій Степанович', 'Олійник Софія Андріївна']);

    await user.type(screen.getByLabelText(/ПІБ \(як записати в черзі\)/), 'Тестовий Пацієнт');
    await user.selectOptions(screen.getByLabelText('Пріоритет ESI'), '1');
    await user.type(screen.getByLabelText(/Скарга/), 'Зупинка дихання');
    await user.click(screen.getByRole('button', { name: 'Додати в чергу' }));
    await screen.findByText('Тестовий Пацієнт');
    expect((await names())[0]).toBe('Тестовий Пацієнт');

    await user.click(screen.getByRole('button', { name: 'Викликати наступного' }));
    expect(await screen.findByTestId('triage-called')).toHaveTextContent('Тестовий Пацієнт');
    await waitFor(async () => expect(await names()).toEqual(['Невідомий чоловік', 'Бойко Андрій Степанович', 'Олійник Софія Андріївна']));
  });

  it('visit: a major interaction blocks submit until acknowledged, then sends interactionsAcknowledged', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (new URL(request.url).pathname.endsWith('/complete')) bodies.push(await request.clone().json());
    });
    renderAt('/visit/3', 'mock-token-3'); // patient Шевченко currently takes Варфарин (mock)
    await screen.findByText(/Прийом: Шевченко Тарас/);
    await user.type(screen.getByLabelText(/Висновок/), 'ГРВІ');
    await user.type(screen.getByLabelText('Пошук МКХ-10'), 'J06');
    await user.click(await screen.findByRole('button', { name: /J06\.9/ }));
    await user.type(screen.getByLabelText('Пошук препарату'), 'Ібупр');
    await user.click(await screen.findByRole('button', { name: /Ібупрофен/ }));
    await user.type(screen.getByLabelText('Дозування'), '400 мг');
    await user.type(screen.getByLabelText('Частота'), '3 рази');

    const warning = await screen.findByTestId('interaction-warning');
    // pair ordered by medication id (D-33): Ібупрофен #2, Варфарин #11; classA = class of the first one
    expect(warning).toHaveTextContent('Ібупрофен + Варфарин');
    expect(warning).toHaveTextContent('серйозна');
    expect(warning).toHaveTextContent('через класи: НПЗЗ × Антикоагулянти');
    const submit = screen.getByRole('button', { name: 'Завершити прийом' });
    await waitFor(() => expect(submit).toBeDisabled());
    expect(screen.getByTestId('ack-required')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Підтверджую, що ознайомлений із взаємодією major'));
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    expect(await screen.findByText('Прийом завершено')).toBeInTheDocument();
    expect(bodies[0]).toMatchObject({ interactionsAcknowledged: true, prescription: { items: [{ medicationId: 2 }] } });
  });

  it('inpatient: bed counters per ward with source and reconciliation time', async () => {
    renderAt('/inpatient', 'mock-token-1');
    const card = await screen.findByTestId('bed-counters');
    expect(card).toHaveTextContent(/Вільних ліжок: \d+ з 12/);
    expect(screen.getByTestId('bed-counters-source')).toHaveTextContent('Redis');
    expect(card).toHaveTextContent('Палата 202');
  });

  it('ICU: initial alert, live vitals and a streamed critical alert highlight the bed', async () => {
    renderAt('/icu', 'mock-token-3');
    expect(await screen.findByTestId('icu-alerts')).toHaveTextContent('ЧСС 148 (поріг > 140)');
    await waitFor(() => expect(screen.getByTestId('stream-state')).toHaveTextContent(/наживо|перепідключення/), { timeout: 4000 });
    await waitFor(() => expect(within(screen.getByTestId('icu-alerts')).getAllByRole('row').length).toBeGreaterThanOrEqual(3), { timeout: 4000 });
    const bed = screen.getByTestId('icu-bed-8');
    expect(bed).toHaveAttribute('data-alerting', 'true');
    expect(within(bed).getByText('Кравченко Богдан Олексійович')).toBeInTheDocument();
  });

  it('logout revokes the token server-side before leaving', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    server.events.on('request:start', ({ request }) => calls.push(`${request.method} ${new URL(request.url).pathname}`));
    renderAt('/', 'mock-token-1');
    await user.click(await screen.findByRole('button', { name: 'Вийти' }));
    await screen.findByRole('button', { name: 'Увійти' });
    expect(calls).toContain('POST /api/auth/logout');
  });
});
