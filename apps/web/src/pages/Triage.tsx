import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Group, NativeSelect, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { Controller, get } from 'react-hook-form';
import { TriageAddInput, type TriageEntry } from '@clinic/contracts';
import { ApiError, useApi, useApiMutation } from '../api';
import { FormError, PatientPicker, applyApiError, bind, errorText, fmtTime, useZodForm } from '../ui';

// F-40 emergency triage queue (Redis sorted set, BR-14): ESI ascending, then arrival time; "call next" = ZPOPMIN.

export const ESI: Record<number, [string, string]> = {
  1: ['ESI 1 — реанімація', 'red'],
  2: ['ESI 2 — невідкладно', 'orange'],
  3: ['ESI 3 — терміново', 'yellow'],
  4: ['ESI 4 — менш терміново', 'green'],
  5: ['ESI 5 — не терміново', 'blue'],
};

const waited = (iso: string, now: number) => {
  const min = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  return min < 60 ? `${min} хв` : `${Math.floor(min / 60)} год ${min % 60} хв`;
};

function QueueError({ error }: { error: unknown }) {
  if (!error) return null;
  const down = error instanceof ApiError && error.envelope.error.code === 'QUEUE_UNAVAILABLE';
  return (
    <Alert color={down ? 'orange' : 'red'} title={down ? 'Черга тимчасово недоступна' : 'Помилка'} data-testid={down ? 'queue-unavailable' : undefined}>
      {down ? 'Сервер черги (Redis) не відповідає. Ведіть пацієнтів за паперовим журналом до відновлення.' : errorText(error)}
    </Alert>
  );
}

export function TriagePage() {
  const queue = useApi('triageList');
  const [called, setCalled] = useState<TriageEntry | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const form = useZodForm(TriageAddInput, { patientName: '', complaint: '', esi: 3 });
  const add = useApiMutation('triageAdd', () => form.reset({ patientName: '', complaint: '', esi: 3, patientId: null }));
  const next = useApiMutation('triageCallNext', (r) => setCalled(r.entry));
  const err = (p: string) => get(form.formState.errors, p)?.message as string | undefined;
  const submit = form.handleSubmit((body) => add.mutateAsync({ body }).catch((e) => applyApiError(e, form)));
  const items = queue.data?.items ?? [];

  return (
    <Stack>
      <Title order={2}>Приймальне відділення — тріаж</Title>
      <QueueError error={queue.error ?? next.error} />

      <Card withBorder>
        <form onSubmit={submit} noValidate>
          <Stack>
            <Title order={4}>Нове прибуття</Title>
            <FormError message={form.formState.errors.root?.message} />
            <Controller
              control={form.control}
              name="patientId"
              render={({ field }) => <PatientPicker value={field.value} onChange={(v) => field.onChange(v ?? null)} error={err('patientId')} />}
            />
            <Group grow align="flex-start">
              <TextInput label="ПІБ (як записати в черзі)" withAsterisk {...bind(form, 'patientName')} />
              <NativeSelect
                label="Пріоритет ESI"
                data={Object.entries(ESI).map(([v, [l]]) => ({ value: v, label: l }))}
                {...bind(form, 'esi', { valueAsNumber: true })}
              />
            </Group>
            <TextInput label="Скарга" withAsterisk {...bind(form, 'complaint')} />
            <Button type="submit" w={200} loading={add.isPending}>
              Додати в чергу
            </Button>
          </Stack>
        </form>
      </Card>

      <Group justify="space-between">
        <Title order={4}>Черга ({queue.data?.total ?? 0})</Title>
        <Button color="red" onClick={() => next.mutate({})} loading={next.isPending} disabled={!items.length}>
          Викликати наступного
        </Button>
      </Group>
      {called && (
        <Alert color="blue" title="Викликано" withCloseButton onClose={() => setCalled(null)} data-testid="triage-called">
          {called.patientName} · {ESI[called.esi]?.[0]} · {called.complaint}
        </Alert>
      )}
      {next.data && !next.data.entry && <Alert color="gray">Черга порожня</Alert>}
      <Table striped data-testid="triage-queue">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>№</Table.Th>
            <Table.Th>Пріоритет</Table.Th>
            <Table.Th>Пацієнт</Table.Th>
            <Table.Th>Скарга</Table.Th>
            <Table.Th>Прибув</Table.Th>
            <Table.Th>Очікує</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.map((e) => (
            <Table.Tr key={e.id}>
              <Table.Td>{e.position}</Table.Td>
              <Table.Td>
                <Badge color={ESI[e.esi]?.[1]} variant="filled">
                  ESI {e.esi}
                </Badge>
              </Table.Td>
              <Table.Td>{e.patientName}</Table.Td>
              <Table.Td>{e.complaint}</Table.Td>
              <Table.Td>{fmtTime(e.arrivedAt)}</Table.Td>
              <Table.Td>{waited(e.arrivedAt, now)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {queue.data && !items.length && <Text c="dimmed">Черга порожня</Text>}
    </Stack>
  );
}
