import { useState } from 'react';
import { BarChart } from '@mantine/charts';
import { Alert, Anchor, Button, Card, Checkbox, Group, NativeSelect, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { Link, useParams } from 'react-router';
import { InvoiceStatus, PaymentInput, PaymentMethod } from '@clinic/contracts';
import { useApi, useApiMutation } from '../api';
import { ErrorAlert, FormError, INVOICE_STATUS, PAYMENT_METHOD, PatientPicker, StatusBadge, applyApiError, bind, fmtDate, fmtDateTime, money, useZodForm } from '../ui';

export function InvoicesPage() {
  const [status, setStatus] = useState<InvoiceStatus | ''>('');
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  const [patientId, setPatientId] = useState<number | undefined>();
  const list = useApi('listInvoices', { query: { status: status || undefined, unpaidOnly: unpaidOnly ? 'true' : undefined, patientId, limit: 100 } });
  return (
    <Stack>
      <Title order={2}>Рахунки</Title>
      <Card withBorder>
        <Group align="flex-end">
          <NativeSelect
            label="Статус"
            value={status}
            onChange={(e) => setStatus(e.currentTarget.value as InvoiceStatus | '')}
            data={[{ value: '', label: 'Усі' }, ...InvoiceStatus.options.map((s) => ({ value: s, label: INVOICE_STATUS[s]![0] }))]}
          />
          <Checkbox label="Лише неоплачені" checked={unpaidOnly} onChange={(e) => setUnpaidOnly(e.currentTarget.checked)} mb={8} />
          <div style={{ flex: 1 }}>
            <PatientPicker value={patientId} onChange={setPatientId} />
          </div>
        </Group>
      </Card>
      <ErrorAlert error={list.error} />
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Номер</Table.Th>
            <Table.Th>Пацієнт</Table.Th>
            <Table.Th>До сплати</Table.Th>
            <Table.Th>Сплачено</Table.Th>
            <Table.Th>Залишок</Table.Th>
            <Table.Th>Термін</Table.Th>
            <Table.Th>Статус</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {list.data?.items.map((i) => (
            <Table.Tr key={i.id}>
              <Table.Td>
                <Anchor component={Link} to={`/invoices/${i.id}`}>
                  {i.number}
                </Anchor>
              </Table.Td>
              <Table.Td>{i.patientName}</Table.Td>
              <Table.Td>{money(i.totalDue)}</Table.Td>
              <Table.Td>{money(i.paidAmount)}</Table.Td>
              <Table.Td>{money(i.balance)}</Table.Td>
              <Table.Td c={i.isOverdue ? 'red' : undefined}>
                {fmtDate(i.dueDate)}
                {i.isOverdue && ' (прострочено)'}
              </Table.Td>
              <Table.Td>
                <StatusBadge map={INVOICE_STATUS} value={i.status} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Text c="dimmed" size="sm">
        Усього: {list.data?.total ?? 0}
      </Text>
    </Stack>
  );
}

function PaymentForm({ invoiceId }: { invoiceId: number }) {
  const form = useZodForm(PaymentInput, { method: 'cash', reference: '' });
  const pay = useApiMutation('registerPayment', () => form.reset());
  const submit = form.handleSubmit((body) => pay.mutateAsync({ params: { id: invoiceId }, body }).catch((e) => applyApiError(e, form)));
  return (
    <form onSubmit={submit} noValidate>
      <Stack gap="xs">
        <Title order={4}>Прийняти оплату</Title>
        <FormError message={form.formState.errors.root?.message} />
        <Group align="flex-start">
          <TextInput label="Сума, грн" type="number" step="0.01" {...bind(form, 'amount', { valueAsNumber: true })} />
          <NativeSelect label="Спосіб" data={PaymentMethod.options.map((m) => ({ value: m, label: PAYMENT_METHOD[m]! }))} {...bind(form, 'method')} />
          <TextInput label="Референс" {...bind(form, 'reference')} />
        </Group>
        <Button type="submit" w={200} loading={pay.isPending}>
          Зареєструвати оплату
        </Button>
      </Stack>
    </form>
  );
}

export function InvoiceDetailPage() {
  const id = Number(useParams().id);
  const inv = useApi('getInvoice', { params: { id } });
  const issue = useApiMutation('issueInvoice');
  if (inv.error) return <ErrorAlert error={inv.error} />;
  const i = inv.data;
  if (!i) return <Text>Завантаження…</Text>;
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Рахунок {i.number}</Title>
        <StatusBadge map={INVOICE_STATUS} value={i.status} />
      </Group>
      <Text>
        Пацієнт:{' '}
        <Anchor component={Link} to={`/patients/${i.patientId}`}>
          {i.patientName}
        </Anchor>{' '}
        · виставлено {fmtDateTime(i.issuedAt)} · сплатити до {fmtDate(i.dueDate)}
      </Text>
      {i.isOverdue && <Alert color="red">Рахунок прострочено</Alert>}
      <SimpleGrid cols={{ base: 2, md: 5 }}>
        {(
          [
            ['Сума', i.subtotal],
            [`Страховка (${i.insuranceCoveragePercent}%)`, i.insuranceAmount],
            ['До сплати', i.totalDue],
            ['Сплачено', i.paidAmount],
            ['Залишок', i.balance],
          ] as const
        ).map(([label, v]) => (
          <Card withBorder key={label} p="sm">
            <Text size="xs" c="dimmed">
              {label}
            </Text>
            <Text fw={700}>{money(v)}</Text>
          </Card>
        ))}
      </SimpleGrid>
      <Title order={4}>Позиції</Title>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Опис</Table.Th>
            <Table.Th>К-сть</Table.Th>
            <Table.Th>Ціна</Table.Th>
            <Table.Th>Сума</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {i.items.map((it) => (
            <Table.Tr key={it.id}>
              <Table.Td>{it.description}</Table.Td>
              <Table.Td>{it.quantity}</Table.Td>
              <Table.Td>{money(it.unitPrice)}</Table.Td>
              <Table.Td>{money(it.amount)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Title order={4}>Оплати</Title>
      {i.payments.length === 0 ? (
        <Text c="dimmed">Оплат ще не було</Text>
      ) : (
        <Table>
          <Table.Tbody>
            {i.payments.map((p) => (
              <Table.Tr key={p.id}>
                <Table.Td>{fmtDateTime(p.paidAt)}</Table.Td>
                <Table.Td>{money(p.amount)}</Table.Td>
                <Table.Td>{PAYMENT_METHOD[p.method]}</Table.Td>
                <Table.Td>{p.reference ?? '—'}</Table.Td>
                <Table.Td>{p.receivedByEmail}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {i.status === 'draft' && (
        <Button w={200} loading={issue.isPending} onClick={() => issue.mutate({ params: { id }, body: {} })}>
          Виставити рахунок
        </Button>
      )}
      <ErrorAlert error={issue.error} />
      {(i.status === 'issued' || i.status === 'partially_paid') && (
        <Card withBorder>
          <PaymentForm invoiceId={id} />
        </Card>
      )}
    </Stack>
  );
}

export function RevenuePage() {
  const revenue = useApi('revenue');
  const refresh = useApiMutation('refreshReports');
  const byMonth = new Map<string, Record<string, number | string>>();
  for (const r of revenue.data ?? []) {
    const row = byMonth.get(r.month) ?? { month: new Date(`${r.month}T12:00:00`).toLocaleDateString('uk-UA', { month: 'short', year: 'numeric' }) };
    row[r.method] = ((row[r.method] as number | undefined) ?? 0) + r.total;
    byMonth.set(r.month, row);
  }
  const colors: Record<string, string> = { cash: 'teal.6', card: 'blue.6', bank_transfer: 'grape.6', insurance: 'orange.6' };
  const methods = PaymentMethod.options.filter((m) => revenue.data?.some((r) => r.method === m));
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Виручка по місяцях</Title>
        <Button variant="light" loading={refresh.isPending} onClick={() => refresh.mutate({})}>
          Оновити звіт
        </Button>
      </Group>
      <ErrorAlert error={revenue.error ?? refresh.error} />
      <BarChart
        h={340}
        data={[...byMonth.values()]}
        dataKey="month"
        type="stacked"
        withLegend
        valueFormatter={(v) => money(v)}
        series={methods.map((m) => ({ name: m, label: PAYMENT_METHOD[m], color: colors[m]! }))}
      />
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Місяць</Table.Th>
            <Table.Th>Відділення</Table.Th>
            <Table.Th>Спосіб</Table.Th>
            <Table.Th>Платежів</Table.Th>
            <Table.Th>Сума</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {revenue.data?.map((r) => (
            <Table.Tr key={`${r.month}-${r.departmentName}-${r.method}`}>
              <Table.Td>{r.month.slice(0, 7)}</Table.Td>
              <Table.Td>{r.departmentName}</Table.Td>
              <Table.Td>{PAYMENT_METHOD[r.method]}</Table.Td>
              <Table.Td>{r.paymentsCount}</Table.Td>
              <Table.Td>{money(r.total)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
