import { useState } from 'react';
import { ActionIcon, Alert, Anchor, Button, Card, Checkbox, Group, List, NativeSelect, SimpleGrid, Stack, Table, Text, TextInput, Textarea, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { Controller, get, useFieldArray } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router';
import { VisitCompleteInput, type VisitCompleteResult } from '@clinic/contracts';
import { useApi, useApiMutation, useMe } from '../api';
import { APPT_STATUS, DoctorSelect, ErrorAlert, FormError, StatusBadge, applyApiError, bind, fmtDateTime, fmtTime, useZodForm } from '../ui';

export function DoctorDayPage() {
  const me = useMe().data!;
  const [picked, setPicked] = useState<number | undefined>();
  const doctorId = me.doctorId ?? picked;
  const list = useApi('todayAppointments', { query: { doctorId } }, !!doctorId);
  const setStatus = useApiMutation('setAppointmentStatus');
  const navigate = useNavigate();
  const start = async (id: number, status: string) => {
    if (status !== 'in_progress') await setStatus.mutateAsync({ params: { id }, body: { status: 'in_progress' } });
    navigate(`/visit/${id}`);
  };

  return (
    <Stack>
      <Title order={2}>Прийоми на сьогодні</Title>
      {!me.doctorId && <DoctorSelect value={picked} onChange={setPicked} />}
      <ErrorAlert error={list.error ?? setStatus.error} />
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Час</Table.Th>
            <Table.Th>Пацієнт</Table.Th>
            <Table.Th>Причина</Table.Th>
            <Table.Th>Статус</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {list.data?.map((a) => (
            <Table.Tr key={a.id}>
              <Table.Td>
                {fmtTime(a.startsAt)}–{fmtTime(a.endsAt)}
              </Table.Td>
              <Table.Td>
                <Anchor component={Link} to={`/patients/${a.patientId}`}>
                  {a.patientName}
                </Anchor>
              </Table.Td>
              <Table.Td>{a.reason ?? '—'}</Table.Td>
              <Table.Td>
                <StatusBadge map={APPT_STATUS} value={a.status} />
              </Table.Td>
              <Table.Td>
                <Group gap="xs">
                  {['scheduled', 'confirmed', 'in_progress'].includes(a.status) && (
                    <Button size="xs" onClick={() => void start(a.id, a.status)}>
                      {a.status === 'in_progress' ? 'Продовжити прийом' : 'Почати прийом'}
                    </Button>
                  )}
                  {a.status === 'scheduled' && (
                    <Button size="xs" variant="light" onClick={() => setStatus.mutate({ params: { id: a.id }, body: { status: 'confirmed' } })}>
                      Підтвердити
                    </Button>
                  )}
                  {(a.status === 'scheduled' || a.status === 'confirmed') && (
                    <Button size="xs" variant="subtle" color="red" onClick={() => setStatus.mutate({ params: { id: a.id }, body: { status: 'no_show' } })}>
                      Не зʼявився
                    </Button>
                  )}
                  {a.medicalRecordId && <Text size="xs">Медичний запис №{a.medicalRecordId}</Text>}
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {list.data?.length === 0 && <Text c="dimmed">На сьогодні прийомів немає</Text>}
    </Stack>
  );
}

export function VisitPage() {
  const id = Number(useParams().id);
  const appt = useApi('getAppointment', { params: { id } });
  const [result, setResult] = useState<VisitCompleteResult | null>(null);
  const testTypes = useApi('listLabTestTypes');
  const form = useZodForm(
    VisitCompleteInput,
    {
      complaints: '',
      examination: '',
      conclusion: '',
      recommendations: '',
      diagnoses: [],
      prescription: { validUntil: '', items: [] },
      labOrder: { priority: 'routine', testCodes: [] },
    },
    (v) => ({ ...v, prescription: v.prescription?.items.length ? v.prescription : null, labOrder: v.labOrder?.testCodes.length ? v.labOrder : null }),
  );
  const dx = useFieldArray({ control: form.control, name: 'diagnoses' });
  const rx = useFieldArray({ control: form.control, name: 'prescription.items' });
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [icdQ, setIcdQ] = useState('');
  const [medQ, setMedQ] = useState('');
  const [dIcdQ] = useDebouncedValue(icdQ, 300);
  const [dMedQ] = useDebouncedValue(medQ, 300);
  const icd = useApi('searchIcd10', { query: { q: dIcdQ, limit: 8 } }, !!dIcdQ).data ?? [];
  const meds = useApi('searchMedications', { query: { q: dMedQ, limit: 8 } }, !!dMedQ).data ?? [];
  const complete = useApiMutation('completeVisit', setResult);
  const errors = form.formState.errors;
  const err = (path: string) => (get(errors, `${path}.root`) ?? get(errors, path))?.message as string | undefined;
  const submit = form.handleSubmit((body) => complete.mutateAsync({ params: { id }, body }).catch((e) => applyApiError(e, form)));

  if (appt.error) return <ErrorAlert error={appt.error} />;
  const a = appt.data;
  if (!a) return <Text>Завантаження…</Text>;

  if (result)
    return (
      <Stack>
        <Alert color="green" title="Прийом завершено">
          <List size="sm">
            <List.Item>Медичний запис №{result.medicalRecordId}</List.Item>
            <List.Item>Діагнози: {result.diagnosisIds.map((d) => `№${d}`).join(', ')}</List.Item>
            <List.Item>Рецепт: {result.prescriptionId ? `№${result.prescriptionId}` : '—'}</List.Item>
            <List.Item>Направлення на аналізи: {result.labOrderId ? `№${result.labOrderId}` : '—'}</List.Item>
            <List.Item>Рахунок: №{result.invoiceId}</List.Item>
          </List>
        </Alert>
        <Anchor component={Link} to="/doctor">
          До списку прийомів
        </Anchor>
      </Stack>
    );

  return (
    <form onSubmit={submit} noValidate>
      <Stack>
        <Title order={2}>Прийом: {a.patientName}</Title>
        <Text c="dimmed">
          {fmtDateTime(a.startsAt)} · {a.doctorName} · {a.reason ?? 'без причини'} · <StatusBadge map={APPT_STATUS} value={a.status} />
        </Text>
        {a.status === 'completed' && <Alert color="yellow">Цей прийом уже завершено (медичний запис №{a.medicalRecordId}).</Alert>}
        <FormError message={errors.root?.message} />

        <Card withBorder>
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            <Textarea label="Скарги" autosize minRows={2} {...bind(form, 'complaints')} />
            <Textarea label="Огляд" autosize minRows={2} {...bind(form, 'examination')} />
            <Textarea label="Висновок" withAsterisk autosize minRows={2} {...bind(form, 'conclusion')} />
            <Textarea label="Рекомендації" autosize minRows={2} {...bind(form, 'recommendations')} />
          </SimpleGrid>
        </Card>

        <Card withBorder>
          <Title order={4}>Діагнози (МКХ-10)</Title>
          <TextInput label="Пошук МКХ-10" placeholder="Код або назва" value={icdQ} onChange={(e) => setIcdQ(e.currentTarget.value)} />
          <Group gap="xs" mt="xs">
            {icd.map((c) => (
              <Button
                key={c.code}
                size="xs"
                variant="light"
                onClick={() => {
                  setTitles((t) => ({ ...t, [c.code]: c.title }));
                  dx.append({ icd10Code: c.code, kind: dx.fields.length ? 'secondary' : 'primary', notes: '' });
                  setIcdQ('');
                }}
              >
                + {c.code} {c.title}
              </Button>
            ))}
          </Group>
          <Stack gap="xs" mt="sm">
            {dx.fields.map((f, i) => (
              <Group key={f.id} align="flex-end" wrap="nowrap">
                <Text w={320} size="sm">
                  <b>{form.getValues(`diagnoses.${i}.icd10Code`)}</b> {titles[form.getValues(`diagnoses.${i}.icd10Code`)]}
                </Text>
                <NativeSelect
                  label="Тип"
                  data={[
                    { value: 'primary', label: 'Основний' },
                    { value: 'secondary', label: 'Супутній' },
                  ]}
                  {...bind(form, `diagnoses.${i}.kind`)}
                />
                <TextInput label="Примітка" style={{ flex: 1 }} {...bind(form, `diagnoses.${i}.notes`)} />
                <ActionIcon color="red" variant="subtle" aria-label="Прибрати діагноз" onClick={() => dx.remove(i)}>
                  ✕
                </ActionIcon>
              </Group>
            ))}
          </Stack>
          {err('diagnoses') && (
            <Text c="red" size="sm" mt="xs">
              {err('diagnoses')}
            </Text>
          )}
        </Card>

        <Card withBorder>
          <Title order={4}>Рецепт</Title>
          <TextInput label="Пошук препарату" value={medQ} onChange={(e) => setMedQ(e.currentTarget.value)} />
          <Group gap="xs" mt="xs">
            {meds.map((m) => (
              <Button
                key={m.id}
                size="xs"
                variant="light"
                onClick={() => {
                  setTitles((t) => ({ ...t, [`med${m.id}`]: `${m.name} ${m.strength ?? ''}` }));
                  rx.append({ medicationId: m.id, dosage: '', frequency: '', durationDays: 5, quantity: 1, instructions: '' });
                  setMedQ('');
                }}
              >
                + {m.name} {m.strength}
              </Button>
            ))}
          </Group>
          <Stack gap="xs" mt="sm">
            {rx.fields.map((f, i) => (
              <Group key={f.id} align="flex-end" wrap="nowrap">
                <Text w={160} size="sm">
                  {titles[`med${form.getValues(`prescription.items.${i}.medicationId`)}`]}
                </Text>
                <TextInput label="Дозування" {...bind(form, `prescription.items.${i}.dosage`)} />
                <TextInput label="Частота" {...bind(form, `prescription.items.${i}.frequency`)} />
                <TextInput label="Днів" type="number" w={80} {...bind(form, `prescription.items.${i}.durationDays`, { valueAsNumber: true })} />
                <TextInput label="К-сть" type="number" w={80} {...bind(form, `prescription.items.${i}.quantity`, { valueAsNumber: true })} />
                <TextInput label="Інструкції" style={{ flex: 1 }} {...bind(form, `prescription.items.${i}.instructions`)} />
                <ActionIcon color="red" variant="subtle" aria-label="Прибрати препарат" onClick={() => rx.remove(i)}>
                  ✕
                </ActionIcon>
              </Group>
            ))}
          </Stack>
          {rx.fields.length > 0 && <TextInput label="Рецепт дійсний до" type="date" w={200} mt="xs" {...bind(form, 'prescription.validUntil')} />}
        </Card>

        <Card withBorder>
          <Title order={4}>Направлення на аналізи</Title>
          <NativeSelect
            label="Пріоритет"
            w={200}
            data={[
              { value: 'routine', label: 'Плановий' },
              { value: 'urgent', label: 'Терміновий' },
            ]}
            {...bind(form, 'labOrder.priority')}
          />
          <Controller
            control={form.control}
            name="labOrder.testCodes"
            render={({ field }) => (
              <Checkbox.Group label="Аналізи" value={field.value ?? []} onChange={field.onChange} error={err('labOrder.testCodes')} mt="xs">
                <Group mt="xs">
                  {testTypes.data?.map((t) => (
                    <Checkbox key={t.code} value={t.code} label={`${t.name} (${t.code})`} />
                  ))}
                </Group>
              </Checkbox.Group>
            )}
          />
        </Card>

        <Button type="submit" w={240} loading={complete.isPending} disabled={a.status === 'completed'}>
          Завершити прийом
        </Button>
      </Stack>
    </form>
  );
}
