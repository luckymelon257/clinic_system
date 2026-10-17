import { useState } from 'react';
import { Badge, Button, Modal, NativeSelect, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { LabResultInput, canAccess, routes, type LabPriority, type LabQueueItem, type LabResult } from '@clinic/contracts';
import { useApi, useApiMutation, useMe } from '../api';
import { ErrorAlert, FormError, applyApiError, bind, fmtDateTime, useZodForm } from '../ui';

const ref = (r: { refMin: number | null; refMax: number | null; unit: string | null }) =>
  r.refMin === null && r.refMax === null ? '—' : `${r.refMin ?? '…'}–${r.refMax ?? '…'} ${r.unit ?? ''}`;

function ResultForm({ item, onDone }: { item: LabQueueItem; onDone: (r: LabResult) => void }) {
  const form = useZodForm(LabResultInput, { testTypeId: item.testTypeId, valueText: '' });
  const save = useApiMutation('recordLabResult', onDone);
  const submit = form.handleSubmit((body) => save.mutateAsync({ params: { id: item.orderId }, body }).catch((e) => applyApiError(e, form)));
  return (
    <form onSubmit={submit} noValidate>
      <Stack>
        <Text size="sm">
          {item.patientName} · {item.testName} ({item.testCode}) · норма: {ref(item)}
        </Text>
        <FormError message={form.formState.errors.root?.message} />
        <TextInput label={`Числове значення${item.unit ? `, ${item.unit}` : ''}`} type="number" step="any" {...bind(form, 'valueNumeric', { valueAsNumber: true })} />
        <TextInput label="Текстовий результат" {...bind(form, 'valueText')} />
        <Button type="submit" loading={save.isPending}>
          Зберегти результат
        </Button>
      </Stack>
    </form>
  );
}

export function LabPage() {
  const me = useMe().data!;
  const [priority, setPriority] = useState<LabPriority | ''>('');
  const queue = useApi('labQueue', { query: { priority: priority || undefined } });
  const [editing, setEditing] = useState<LabQueueItem | null>(null);
  const [orderId, setOrderId] = useState<number | null>(null);
  const results = useApi('labOrderResults', { params: { id: orderId ?? 0 } }, !!orderId);
  const canRecord = canAccess(routes.recordLabResult, me.role);

  return (
    <Stack>
      <Title order={2}>Черга лабораторії</Title>
      <NativeSelect
        w={220}
        label="Пріоритет"
        value={priority}
        onChange={(e) => setPriority(e.currentTarget.value as LabPriority | '')}
        data={[
          { value: '', label: 'Усі' },
          { value: 'urgent', label: 'Термінові' },
          { value: 'routine', label: 'Планові' },
        ]}
      />
      <ErrorAlert error={queue.error} />
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Направлення</Table.Th>
            <Table.Th>Пацієнт</Table.Th>
            <Table.Th>Аналіз</Table.Th>
            <Table.Th>Норма</Table.Th>
            <Table.Th>Пріоритет</Table.Th>
            <Table.Th>Створено</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {queue.data?.map((q) => (
            <Table.Tr key={`${q.orderId}-${q.testTypeId}`}>
              <Table.Td>
                <Button variant="subtle" size="compact-sm" onClick={() => setOrderId(q.orderId)}>
                  №{q.orderId}
                </Button>
              </Table.Td>
              <Table.Td>{q.patientName}</Table.Td>
              <Table.Td>
                {q.testName} ({q.testCode})
              </Table.Td>
              <Table.Td>{ref(q)}</Table.Td>
              <Table.Td>{q.priority === 'urgent' ? <Badge color="red">Терміново</Badge> : <Badge color="gray">Планово</Badge>}</Table.Td>
              <Table.Td>{fmtDateTime(q.orderedAt)}</Table.Td>
              <Table.Td>
                {canRecord && (
                  <Button size="xs" onClick={() => setEditing(q)}>
                    Внести результат
                  </Button>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {queue.data?.length === 0 && <Text c="dimmed">Черга порожня</Text>}

      {orderId && (
        <Stack gap="xs">
          <Title order={4}>Результати направлення №{orderId}</Title>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Аналіз</Table.Th>
                <Table.Th>Значення</Table.Th>
                <Table.Th>Норма</Table.Th>
                <Table.Th>Внесено</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {results.data?.map((r) => (
                <Table.Tr key={r.id} bg={r.isAbnormal ? 'red.1' : undefined} c={r.isAbnormal ? 'red.9' : undefined}>
                  <Table.Td>{r.testName}</Table.Td>
                  <Table.Td>
                    {r.valueNumeric ?? r.valueText} {r.unit} {r.isAbnormal && <Badge color="red">Поза нормою</Badge>}
                  </Table.Td>
                  <Table.Td>{ref(r)}</Table.Td>
                  <Table.Td>
                    {fmtDateTime(r.recordedAt)} · {r.recordedByEmail}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {results.data?.length === 0 && <Text c="dimmed">Результатів ще немає</Text>}
        </Stack>
      )}

      <Modal opened={!!editing} onClose={() => setEditing(null)} title="Результат аналізу">
        {editing && (
          <ResultForm
            item={editing}
            onDone={(r) => {
              setEditing(null);
              setOrderId(r.orderId);
            }}
          />
        )}
      </Modal>
    </Stack>
  );
}
