import { Fragment, useState } from 'react';
import { Badge, Button, Card, Code, Group, NativeSelect, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { AuditOperation, SoftDeleteTable, type AuditEntry } from '@clinic/contracts';
import { useApi, useApiMutation } from '../api';
import { ErrorAlert, fmtDateTime } from '../ui';

const OP_COLOR: Record<AuditEntry['operation'], string> = { INSERT: 'green', UPDATE: 'blue', DELETE: 'red', SOFT_DELETE: 'orange', RESTORE: 'teal' };
const show = (v: unknown) => (v === undefined ? '' : JSON.stringify(v));

/** oldData vs newData, one row per key; keys from changedFields are highlighted. */
function JsonDiff({ e }: { e: AuditEntry }) {
  const keys = [...new Set([...Object.keys(e.oldData ?? {}), ...Object.keys(e.newData ?? {})])];
  const changed = new Set(e.changedFields ?? []);
  return (
    <Table withTableBorder fz="xs">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Поле</Table.Th>
          <Table.Th>Було</Table.Th>
          <Table.Th>Стало</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {keys.map((k) => (
          <Table.Tr key={k} bg={changed.has(k) ? 'yellow.1' : undefined} data-changed={changed.has(k) || undefined}>
            <Table.Td fw={changed.has(k) ? 700 : undefined}>{k}</Table.Td>
            <Table.Td c={changed.has(k) ? 'red.8' : undefined}>
              <Code>{show(e.oldData?.[k])}</Code>
            </Table.Td>
            <Table.Td c={changed.has(k) ? 'green.8' : undefined}>
              <Code>{show(e.newData?.[k])}</Code>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export function AuditPage() {
  const [tableName, setTableName] = useState('');
  const [recordId, setRecordId] = useState('');
  const [operation, setOperation] = useState<AuditOperation | ''>('');
  const [open, setOpen] = useState<number | null>(null);
  const log = useApi('auditLog', { query: { tableName: tableName || undefined, recordId: recordId || undefined, operation: operation || undefined, limit: 100 } });
  return (
    <Stack>
      <Title order={2}>Журнал аудиту</Title>
      <Card withBorder>
        <Group>
          <TextInput label="Таблиця" placeholder="patients" value={tableName} onChange={(e) => setTableName(e.currentTarget.value)} />
          <TextInput label="ID запису" type="number" value={recordId} onChange={(e) => setRecordId(e.currentTarget.value)} />
          <NativeSelect label="Операція" value={operation} onChange={(e) => setOperation(e.currentTarget.value as AuditOperation | '')} data={['', ...AuditOperation.options]} />
        </Group>
      </Card>
      <ErrorAlert error={log.error} />
      <Table highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Коли</Table.Th>
            <Table.Th>Хто</Table.Th>
            <Table.Th>Таблиця</Table.Th>
            <Table.Th>ID</Table.Th>
            <Table.Th>Операція</Table.Th>
            <Table.Th>Змінені поля</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {log.data?.items.map((e) => (
            <Fragment key={e.id}>
              <Table.Tr style={{ cursor: 'pointer' }} onClick={() => setOpen(open === e.id ? null : e.id)}>
                <Table.Td>{fmtDateTime(e.changedAt)}</Table.Td>
                <Table.Td>{e.changedByEmail ?? 'система'}</Table.Td>
                <Table.Td>{e.tableName}</Table.Td>
                <Table.Td>{e.recordId}</Table.Td>
                <Table.Td>
                  <Badge color={OP_COLOR[e.operation]}>{e.operation}</Badge>
                </Table.Td>
                <Table.Td>{e.changedFields?.join(', ') ?? '—'}</Table.Td>
              </Table.Tr>
              {open === e.id && (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <JsonDiff e={e} />
                  </Table.Td>
                </Table.Tr>
              )}
            </Fragment>
          ))}
        </Table.Tbody>
      </Table>
      <Text c="dimmed" size="sm">
        Усього записів: {log.data?.total ?? 0}. Натисніть на рядок, щоб побачити зміни.
      </Text>
    </Stack>
  );
}

export function DeletedPage() {
  const [tableName, setTableName] = useState<SoftDeleteTable | ''>('');
  const list = useApi('deletedRecords', { query: { tableName: tableName || undefined } });
  const restore = useApiMutation('restore');
  return (
    <Stack>
      <Title order={2}>Видалені записи</Title>
      <NativeSelect w={240} label="Таблиця" value={tableName} onChange={(e) => setTableName(e.currentTarget.value as SoftDeleteTable | '')} data={['', ...SoftDeleteTable.options]} />
      <ErrorAlert error={list.error ?? restore.error} />
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Таблиця</Table.Th>
            <Table.Th>Запис</Table.Th>
            <Table.Th>Видалено</Table.Th>
            <Table.Th>Ким</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {list.data?.map((d) => (
            <Table.Tr key={`${d.tableName}-${d.recordId}`}>
              <Table.Td>{d.tableName}</Table.Td>
              <Table.Td>
                {d.label} (#{d.recordId})
              </Table.Td>
              <Table.Td>{fmtDateTime(d.deletedAt)}</Table.Td>
              <Table.Td>{d.deletedByEmail ?? '—'}</Table.Td>
              <Table.Td>
                <Button size="xs" variant="light" loading={restore.isPending} onClick={() => restore.mutate({ params: { table: d.tableName, id: d.recordId } })}>
                  Відновити
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {list.data?.length === 0 && <Text c="dimmed">Видалених записів немає</Text>}
    </Stack>
  );
}
