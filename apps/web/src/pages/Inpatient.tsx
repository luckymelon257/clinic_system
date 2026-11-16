import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Card, Group, Modal, NativeSelect, Paper, SimpleGrid, Stack, Table, Text, TextInput, Textarea, Title } from '@mantine/core';
import { Controller, get } from 'react-hook-form';
import { Link } from 'react-router';
import { AdmitInput, DischargeInput, TransferInput, type Bed } from '@clinic/contracts';
import { useApi, useApiMutation } from '../api';
import { DoctorSelect, ErrorAlert, FormError, PatientPicker, applyApiError, bind, fmtDateTime, useZodForm } from '../ui';

const BED_COLOR: Record<Bed['status'], string> = { available: 'green', occupied: 'red', maintenance: 'gray' };
const BED_LABEL: Record<Bed['status'], string> = { available: 'Вільне', occupied: 'Зайняте', maintenance: 'Обслуговування' };
const WARD_TYPE: Record<Bed['wardType'], string> = { general: 'загальна', semi_private: 'напівприватна', private: 'приватна', icu: 'реанімація' };

function AdmitForm({ bed, onDone }: { bed: Bed; onDone: () => void }) {
  const form = useZodForm(AdmitInput, { bedId: bed.id, reason: '' });
  const admit = useApiMutation('admit', onDone);
  const err = (p: string) => get(form.formState.errors, p)?.message as string | undefined;
  const submit = form.handleSubmit((body) => admit.mutateAsync({ body }).catch((e) => applyApiError(e, form)));
  return (
    <form onSubmit={submit} noValidate>
      <Stack>
        <FormError message={form.formState.errors.root?.message} />
        <Controller control={form.control} name="patientId" render={({ field }) => <PatientPicker value={field.value} onChange={field.onChange} error={err('patientId')} />} />
        <Controller control={form.control} name="doctorId" render={({ field }) => <DoctorSelect value={field.value} onChange={field.onChange} error={err('doctorId')} />} />
        <TextInput label="Причина госпіталізації" {...bind(form, 'reason')} />
        <Button type="submit" loading={admit.isPending}>
          Госпіталізувати
        </Button>
      </Stack>
    </form>
  );
}

function OccupiedBed({ bed, beds, onClose, onDischarged }: { bed: Bed; beds: Bed[]; onClose: () => void; onDischarged: (invoiceId: number) => void }) {
  const id = bed.admissionId!;
  const tForm = useZodForm(TransferInput);
  const transfer = useApiMutation('transfer', onClose);
  const dForm = useZodForm(DischargeInput, { summary: '' });
  const discharge = useApiMutation('discharge', (r) => onDischarged(r.invoiceId));
  const free = beds.filter((b) => b.status === 'available');
  return (
    <Stack>
      <Text>
        Пацієнт:{' '}
        <Anchor component={Link} to={`/patients/${bed.patientId}`}>
          {bed.patientName}
        </Anchor>
      </Text>
      <form onSubmit={tForm.handleSubmit((body) => transfer.mutateAsync({ params: { id }, body }).catch((e) => applyApiError(e, tForm)))} noValidate>
        <Group align="flex-end">
          <NativeSelect
            label="Перевести на ліжко"
            style={{ flex: 1 }}
            data={[{ value: '', label: '—' }, ...free.map((b) => ({ value: String(b.id), label: `${b.departmentName}, палата ${b.wardNumber}, ліжко ${b.bedNumber}` }))]}
            {...bind(tForm, 'bedId', { valueAsNumber: true })}
          />
          <Button type="submit" variant="light" loading={transfer.isPending}>
            Перевести
          </Button>
        </Group>
        <FormError message={tForm.formState.errors.root?.message} />
      </form>
      <form onSubmit={dForm.handleSubmit((body) => discharge.mutateAsync({ params: { id }, body }).catch((e) => applyApiError(e, dForm)))} noValidate>
        <Stack gap="xs">
          <Textarea label="Виписний епікриз" autosize minRows={3} {...bind(dForm, 'summary')} />
          <FormError message={dForm.formState.errors.root?.message} />
          <Button type="submit" color="red" loading={discharge.isPending}>
            Виписати
          </Button>
        </Stack>
      </form>
    </Stack>
  );
}

/** F-43: live free / occupied counters per ward (Redis hash; falls back to v_beds when Redis is down). */
function BedCounters() {
  const counts = useApi('bedCounts');
  if (counts.error) return <ErrorAlert error={counts.error} />;
  const d = counts.data;
  if (!d) return null;
  const free = d.items.reduce((s, w) => s + w.free, 0);
  const total = d.items.reduce((s, w) => s + w.total, 0);
  return (
    <Card withBorder data-testid="bed-counters">
      <Group justify="space-between" mb="xs">
        <Title order={4}>
          Вільних ліжок: {free} з {total}
        </Title>
        <Group gap="xs">
          <Badge variant="light" color={d.source === 'redis' ? 'teal' : 'gray'} data-testid="bed-counters-source">
            джерело: {d.source === 'redis' ? 'Redis (лічильники)' : 'PostgreSQL (резерв)'}
          </Badge>
          <Text size="xs" c="dimmed">
            звірено з v_beds: {fmtDateTime(d.reconciledAt)}
          </Text>
        </Group>
      </Group>
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="xs">
        {d.items.map((w) => (
          <Paper key={w.wardId} withBorder p="xs">
            <Text size="xs" c="dimmed">
              {w.departmentName}
            </Text>
            <Text fw={600} size="sm">
              Палата {w.wardNumber}
            </Text>
            <Text size="sm">
              <Text span c="green" fw={700}>
                {w.free}
              </Text>{' '}
              вільних ·{' '}
              <Text span c="red" fw={700}>
                {w.occupied}
              </Text>{' '}
              зайнятих
            </Text>
          </Paper>
        ))}
      </SimpleGrid>
    </Card>
  );
}

export function InpatientPage() {
  const beds = useApi('listBeds');
  const occupancy = useApi('occupancy');
  const [bed, setBed] = useState<Bed | null>(null);
  const [invoiceId, setInvoiceId] = useState<number | null>(null);
  const all = beds.data ?? [];
  const departments = [...new Set(all.map((b) => b.departmentName))];

  return (
    <Stack>
      <Title order={2}>Стаціонар — карта ліжок</Title>
      <BedCounters />
      <Group gap="xs">
        {(['available', 'occupied', 'maintenance'] as const).map((s) => (
          <Badge key={s} color={BED_COLOR[s]}>
            {BED_LABEL[s]}
          </Badge>
        ))}
      </Group>
      {invoiceId !== null && (
        <Alert color="green" title="Пацієнта виписано" withCloseButton onClose={() => setInvoiceId(null)}>
          Сформовано рахунок{' '}
          <Anchor component={Link} to={`/invoices/${invoiceId}`}>
            №{invoiceId}
          </Anchor>
        </Alert>
      )}
      <ErrorAlert error={beds.error} />
      {departments.map((dep) => {
        const depBeds = all.filter((b) => b.departmentName === dep);
        const wards = [...new Set(depBeds.map((b) => b.wardId))];
        return (
          <Card withBorder key={dep}>
            <Title order={4} mb="sm">
              {dep}
            </Title>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
              {wards.map((w) => {
                const wb = depBeds.filter((b) => b.wardId === w);
                return (
                  <Paper withBorder p="sm" key={w}>
                    <Text fw={600} size="sm">
                      Палата {wb[0]!.wardNumber} ({WARD_TYPE[wb[0]!.wardType]}, {wb[0]!.dailyRate} грн/доба)
                    </Text>
                    <Group gap="xs" mt="xs">
                      {wb.map((b) => (
                        <Button
                          key={b.id}
                          color={BED_COLOR[b.status]}
                          variant={b.status === 'available' ? 'light' : 'filled'}
                          disabled={b.status === 'maintenance'}
                          onClick={() => setBed(b)}
                          title={b.patientName ?? BED_LABEL[b.status]}
                          h={56}
                        >
                          <Stack gap={0} align="center">
                            <Text size="xs">{b.bedNumber}</Text>
                            <Text size="xs">{b.patientName?.split(' ')[0] ?? BED_LABEL[b.status]}</Text>
                          </Stack>
                        </Button>
                      ))}
                    </Group>
                  </Paper>
                );
              })}
            </SimpleGrid>
          </Card>
        );
      })}

      <Title order={4}>Заповненість</Title>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Відділення</Table.Th>
            <Table.Th>Палата</Table.Th>
            <Table.Th>Зайнято</Table.Th>
            <Table.Th>%</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {occupancy.data?.map((o) => (
            <Table.Tr key={`${o.departmentId}-${o.wardId}`} fw={o.wardId === null ? 700 : undefined}>
              <Table.Td>{o.departmentName}</Table.Td>
              <Table.Td>{o.wardNumber ?? 'Усього'}</Table.Td>
              <Table.Td>
                {o.occupiedBeds}/{o.totalBeds}
              </Table.Td>
              <Table.Td>{o.occupancyPercent}%</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Modal opened={!!bed} onClose={() => setBed(null)} title={bed ? `Ліжко ${bed.bedNumber} — ${BED_LABEL[bed.status]}` : ''} size="lg">
        {bed?.status === 'available' && <AdmitForm bed={bed} onDone={() => setBed(null)} />}
        {bed?.status === 'occupied' && (
          <OccupiedBed
            bed={bed}
            beds={all}
            onClose={() => setBed(null)}
            onDischarged={(inv) => {
              setBed(null);
              setInvoiceId(inv);
            }}
          />
        )}
      </Modal>
    </Stack>
  );
}
