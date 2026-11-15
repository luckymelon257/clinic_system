import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Card, Group, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import type { IcuAlert, IcuBed, IcuStreamEvent, VitalSign, Vitals } from '@clinic/contracts';
import { useApi } from '../api';
import { useIcuStream, type StreamState } from '../sse';
import { ErrorAlert, fmtDateTime } from '../ui';

// F-44 ICU monitor: initial state from icuBeds / icuAlerts, then live vitals and alerts over SSE (fetch-based,
// Authorization header — the token is never put in the URL). A bed with a fresh alert is highlighted.

export const SIGN_LABEL: Record<VitalSign, string> = { hr: 'ЧСС', spo2: 'SpO₂', sbp: 'Сист. АТ', dbp: 'Діаст. АТ', rr: 'ЧД', temp: 't°' };
const UNIT: Record<VitalSign, string> = { hr: '/хв', spo2: '%', sbp: 'мм рт. ст.', dbp: 'мм рт. ст.', rr: '/хв', temp: '°C' };
const STATE: Record<StreamState, [string, string]> = {
  connecting: ['зʼєднання…', 'gray'],
  open: ['наживо', 'green'],
  reconnecting: ['перепідключення…', 'yellow'],
  error: ['немає зʼєднання', 'red'],
};
const ALERT_FRESH_MS = 5 * 60_000;

function VitalsGrid({ v, critical }: { v: Vitals; critical: Set<VitalSign> }) {
  return (
    <SimpleGrid cols={3} spacing={6}>
      {(['hr', 'spo2', 'sbp', 'dbp', 'rr', 'temp'] as const).map((s) => (
        <Stack key={s} gap={0}>
          <Text size="xs" c="dimmed">
            {SIGN_LABEL[s]}
          </Text>
          <Text fw={700} c={critical.has(s) ? 'red' : undefined} data-testid={`vital-${s}`}>
            {v[s]} <Text span size="xs" c="dimmed" fw={400}>{UNIT[s]}</Text>
          </Text>
        </Stack>
      ))}
    </SimpleGrid>
  );
}

export function IcuPage() {
  const beds = useApi('icuBeds');
  const initialAlerts = useApi('icuAlerts', { query: { limit: 50 } });
  const [live, setLive] = useState<Record<number, Vitals>>({});
  const [alerts, setAlerts] = useState<IcuAlert[]>([]);
  useEffect(() => {
    if (initialAlerts.data) setAlerts((cur) => [...cur, ...initialAlerts.data.filter((a) => !cur.some((c) => c.id === a.id))]);
  }, [initialAlerts.data]);

  const onEvent = useCallback((e: IcuStreamEvent) => {
    if (e.type === 'vitals') setLive((cur) => ({ ...cur, [e.bedId]: e.vitals }));
    if (e.type === 'alert') setAlerts((cur) => (cur.some((a) => a.id === e.alert.id) ? cur : [e.alert, ...cur].slice(0, 100)));
  }, []);
  const state = useIcuStream(onEvent);

  const freshAlert = (bedId: number) => alerts.find((a) => a.bedId === bedId && Date.now() - Date.parse(a.at) < ALERT_FRESH_MS);
  const list: IcuBed[] = beds.data ?? [];

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Монітор ВІТ</Title>
        <Badge color={STATE[state][1]} variant="dot" data-testid="stream-state" size="lg">
          {STATE[state][0]}
        </Badge>
      </Group>
      <ErrorAlert error={beds.error} />
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
        {list.map((b) => {
          const v = live[b.bedId] ?? b.vitals;
          const alert = freshAlert(b.bedId);
          return (
            <Card key={b.bedId} withBorder data-testid={`icu-bed-${b.bedId}`} data-alerting={alert || b.alerting ? 'true' : 'false'} style={alert || b.alerting ? { borderColor: 'var(--mantine-color-red-6)', borderWidth: 2 } : undefined}>
              <Group justify="space-between" mb="xs">
                <Text fw={700}>
                  Ліжко {b.bedNumber} · палата {b.wardNumber}
                </Text>
                {(alert || b.alerting) && (
                  <Badge color="red" variant="filled">
                    ⚠ критично
                  </Badge>
                )}
              </Group>
              <Text size="sm" mb="xs">
                {b.patientName ?? 'вільне'}
              </Text>
              {v ? (
                <>
                  <VitalsGrid v={v} critical={new Set(alert?.violations.map((x) => x.sign) ?? [])} />
                  <Text size="xs" c="dimmed" mt="xs">
                    оновлено {fmtDateTime(v.at)}
                  </Text>
                </>
              ) : (
                <Text c="dimmed" size="sm">
                  монітор не передає даних
                </Text>
              )}
            </Card>
          );
        })}
      </SimpleGrid>
      {list.length === 0 && !beds.isLoading && <Text c="dimmed">Ліжок ВІТ немає</Text>}

      <Title order={4}>Критичні алерти</Title>
      {alerts.length === 0 ? (
        <Alert color="green">Критичних показників не зафіксовано</Alert>
      ) : (
        <Table striped data-testid="icu-alerts">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Час</Table.Th>
              <Table.Th>Ліжко</Table.Th>
              <Table.Th>Пацієнт</Table.Th>
              <Table.Th>Порушення</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {[...alerts].sort((a, b) => b.at.localeCompare(a.at)).map((a) => (
              <Table.Tr key={a.id}>
                <Table.Td>{fmtDateTime(a.at)}</Table.Td>
                <Table.Td>{list.find((b) => b.bedId === a.bedId)?.bedNumber ?? `#${a.bedId}`}</Table.Td>
                <Table.Td>{a.patientName ?? '—'}</Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {a.violations.map((x) => (
                      <Badge key={x.sign} color="red" variant="light">
                        {SIGN_LABEL[x.sign]} {x.value} (поріг {x.rule})
                      </Badge>
                    ))}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
