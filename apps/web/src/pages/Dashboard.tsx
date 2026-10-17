import { Anchor, Card, Progress, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { Link } from 'react-router';
import { canAccess, routes } from '@clinic/contracts';
import { useApi, useMe } from '../api';
import { APPT_STATUS, INVOICE_STATUS, StatusBadge, fmtTime, money } from '../ui';

export function DashboardPage() {
  const me = useMe().data!;
  const can = (r: keyof typeof routes) => canAccess(routes[r], me.role);
  const todays = useApi('todayAppointments', { query: { doctorId: me.doctorId ?? undefined } }, can('todayAppointments'));
  const occupancy = useApi('occupancy', undefined, can('occupancy'));
  const unpaid = useApi('listInvoices', { query: { unpaidOnly: 'true', limit: 10 } }, can('listInvoices'));
  const queue = useApi('labQueue', undefined, can('labQueue'));

  return (
    <Stack>
      <Title order={2}>Вітаємо, {me.fullName}</Title>
      {me.role === 'patient' && <Text>Особистий кабінет пацієнта не входить до цієї версії системи.</Text>}
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        {can('todayAppointments') && (
          <Card withBorder>
            <Title order={4} mb="sm">
              {me.doctorId ? 'Мої прийоми сьогодні' : 'Прийоми сьогодні'} ({todays.data?.length ?? 0})
            </Title>
            <Table>
              <Table.Tbody>
                {todays.data?.map((a) => (
                  <Table.Tr key={a.id}>
                    <Table.Td>{fmtTime(a.startsAt)}</Table.Td>
                    <Table.Td>{a.patientName}</Table.Td>
                    {!me.doctorId && <Table.Td>{a.doctorName}</Table.Td>}
                    <Table.Td>
                      <StatusBadge map={APPT_STATUS} value={a.status} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Card>
        )}
        {can('occupancy') && (
          <Card withBorder>
            <Title order={4} mb="sm">
              Заповненість стаціонару
            </Title>
            <Stack gap="xs">
              {occupancy.data
                ?.filter((o) => o.wardId === null)
                .map((o) => (
                  <div key={o.departmentId}>
                    <Text size="sm">
                      {o.departmentName}: {o.occupiedBeds}/{o.totalBeds} ({o.occupancyPercent}%)
                    </Text>
                    <Progress value={o.occupancyPercent} color={o.occupancyPercent > 80 ? 'red' : 'teal'} />
                  </div>
                ))}
            </Stack>
          </Card>
        )}
        {can('listInvoices') && (
          <Card withBorder>
            <Title order={4} mb="sm">
              Неоплачені рахунки ({unpaid.data?.total ?? 0})
            </Title>
            <Table>
              <Table.Tbody>
                {unpaid.data?.items.map((i) => (
                  <Table.Tr key={i.id} bg={i.isOverdue ? 'red.0' : undefined}>
                    <Table.Td>
                      <Anchor component={Link} to={`/invoices/${i.id}`}>
                        {i.number}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>{i.patientName}</Table.Td>
                    <Table.Td>{money(i.balance)}</Table.Td>
                    <Table.Td>
                      <StatusBadge map={INVOICE_STATUS} value={i.status} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Card>
        )}
        {can('labQueue') && (
          <Card withBorder>
            <Title order={4} mb="sm">
              Черга лабораторії
            </Title>
            <Text>
              Очікують результату: {queue.data?.length ?? 0}, з них термінових: {queue.data?.filter((q) => q.priority === 'urgent').length ?? 0}
            </Text>
            <Anchor component={Link} to="/lab">
              Перейти до черги
            </Anchor>
          </Card>
        )}
      </SimpleGrid>
    </Stack>
  );
}
