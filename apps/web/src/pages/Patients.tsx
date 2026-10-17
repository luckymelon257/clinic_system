import { useState } from 'react';
import { Anchor, Badge, Button, Card, Group, NativeSelect, SimpleGrid, Stack, Table, Tabs, Text, TextInput, Timeline, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { Link, useNavigate, useParams } from 'react-router';
import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';
import { BloodType, InsuranceCreateInput, PatientUpdateInput, canAccess, routes, type Patient } from '@clinic/contracts';
import { useApi, useApiMutation, useMe } from '../api';
import { ErrorAlert, FormError, applyApiError, bind, fmtDate, fmtDateTime, today, useZodForm } from '../ui';

export function PatientSearchPage() {
  const [q, setQ] = useState('');
  const [dq] = useDebouncedValue(q, 300);
  const found = useApi('searchPatients', { query: { q: dq } });
  const me = useMe().data!;
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Пацієнти</Title>
        {canAccess(routes.register, me.role) && (
          <Button component={Link} to="/registration">
            Новий пацієнт
          </Button>
        )}
      </Group>
      <TextInput placeholder="Пошук за ПІБ або телефоном" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
      <ErrorAlert error={found.error} />
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>ПІБ</Table.Th>
            <Table.Th>Дата народження</Table.Th>
            <Table.Th>Телефон</Table.Th>
            <Table.Th>Страховка</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {found.data?.map((p) => (
            <Table.Tr key={p.id}>
              <Table.Td>
                <Anchor component={Link} to={`/patients/${p.id}`}>
                  {p.fullName}
                </Anchor>
              </Table.Td>
              <Table.Td>
                {fmtDate(p.birthDate)} ({p.age} р.)
              </Table.Td>
              <Table.Td>{p.phone ?? '—'}</Table.Td>
              <Table.Td>{p.insuranceCompanyName ? `${p.insuranceCompanyName}, ${p.insuranceCoveragePercent}%` : '—'}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {found.data?.length === 0 && <Text c="dimmed">Нічого не знайдено</Text>}
    </Stack>
  );
}

/** Patient fields of PatientInput; `p` is the field prefix ('' or 'patient.'). */
export function PatientFields({ form, p = '' }: { form: UseFormReturn<FieldValues, unknown, unknown>; p?: string }) {
  const b = (name: string) => bind(form, `${p}${name}` as Path<FieldValues>);
  return (
    <SimpleGrid cols={{ base: 1, sm: 3 }}>
      <TextInput label="Прізвище" withAsterisk {...b('lastName')} />
      <TextInput label="Імʼя" withAsterisk {...b('firstName')} />
      <TextInput label="По батькові" {...b('middleName')} />
      <TextInput label="Дата народження" type="date" withAsterisk {...b('birthDate')} />
      <NativeSelect
        label="Стать"
        withAsterisk
        data={[
          { value: 'male', label: 'Чоловіча' },
          { value: 'female', label: 'Жіноча' },
        ]}
        {...b('sex')}
      />
      <NativeSelect label="Група крові" data={['', ...BloodType.options]} {...b('bloodType')} />
      <TextInput label="Телефон" placeholder="+380 50 123 45 67" {...b('phone')} />
      <TextInput label="Email" {...b('email')} />
      <TextInput label="Адреса" {...b('address')} />
      <TextInput label="Контакт для екстрених випадків" {...b('emergencyContactName')} />
      <TextInput label="Телефон екстреного контакту" {...b('emergencyContactPhone')} />
    </SimpleGrid>
  );
}

const PATIENT_KEYS = ['lastName', 'firstName', 'middleName', 'birthDate', 'sex', 'phone', 'email', 'address', 'bloodType', 'emergencyContactName', 'emergencyContactPhone'] as const;
export const emptyPatient = { lastName: '', firstName: '', middleName: '', birthDate: '', sex: 'male', phone: '', email: '', address: '', bloodType: null, emergencyContactName: '', emergencyContactPhone: '' } as const;

function PatientEditForm({ patient }: { patient: Patient }) {
  const form = useZodForm(PatientUpdateInput, Object.fromEntries(PATIENT_KEYS.map((k) => [k, patient[k] ?? ''])));
  const update = useApiMutation('updatePatient', () => notifications.show({ color: 'green', message: 'Дані пацієнта збережено' }));
  const submit = form.handleSubmit((body) => update.mutateAsync({ params: { id: patient.id }, body }).catch((e) => applyApiError(e, form)));
  return (
    <form onSubmit={submit} noValidate>
      <Stack>
        <FormError message={form.formState.errors.root?.message} />
        <PatientFields form={form as never} />
        <Group>
          <Button type="submit" loading={update.isPending}>
            Зберегти
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function InsuranceForm({ patientId }: { patientId: number }) {
  const companies = useApi('listInsuranceCompanies');
  const form = useZodForm(InsuranceCreateInput, { policyNumber: '', validFrom: today(), validTo: '' });
  const add = useApiMutation('addInsurance', () => form.reset());
  const submit = form.handleSubmit((body) => add.mutateAsync({ params: { id: patientId }, body }).catch((e) => applyApiError(e, form)));
  return (
    <form onSubmit={submit} noValidate>
      <Stack gap="xs">
        <FormError message={form.formState.errors.root?.message} />
        <InsuranceFields form={form as never} companies={companies.data ?? []} />
        <Group>
          <Button type="submit" loading={add.isPending}>
            Додати поліс
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function InsuranceFields({ form, p = '', companies }: { form: UseFormReturn<FieldValues, unknown, unknown>; p?: string; companies: { id: number; name: string }[] }) {
  const b = (name: string, num = false) => bind(form, `${p}${name}` as Path<FieldValues>, num ? { valueAsNumber: true } : undefined);
  return (
    <SimpleGrid cols={{ base: 1, sm: 5 }}>
      <NativeSelect label="Компанія" data={[{ value: '', label: '—' }, ...companies.map((c) => ({ value: String(c.id), label: c.name }))]} {...b('companyId', true)} />
      <TextInput label="Номер поліса" {...b('policyNumber')} />
      <TextInput label="Покриття, %" type="number" {...b('coveragePercent', true)} />
      <TextInput label="Діє з" type="date" {...b('validFrom')} />
      <TextInput label="Діє до" type="date" {...b('validTo')} />
    </SimpleGrid>
  );
}

const EVENT_LABEL: Record<string, [string, string]> = {
  appointment: ['Прийом', 'blue'],
  diagnosis: ['Діагноз', 'grape'],
  prescription: ['Рецепт', 'teal'],
  lab_order: ['Направлення', 'yellow'],
  lab_result: ['Аналіз', 'orange'],
  admission: ['Госпіталізація', 'red'],
  discharge: ['Виписка', 'green'],
};

export function PatientCardPage() {
  const id = Number(useParams().id);
  const me = useMe().data!;
  const can = (r: keyof typeof routes) => canAccess(routes[r], me.role);
  const navigate = useNavigate();
  const patient = useApi('getPatient', { params: { id } });
  const historyQ = useApi('patientHistory', { params: { id } }, can('patientHistory'));
  const insurances = useApi('patientInsurances', { params: { id } }, can('patientInsurances'));
  const del = useApiMutation('deletePatient', () => navigate('/patients'));

  if (patient.error) return <ErrorAlert error={patient.error} />;
  const p = patient.data;
  if (!p) return <Text>Завантаження…</Text>;
  return (
    <Stack>
      <Group justify="space-between">
        <div>
          <Title order={2}>{p.fullName}</Title>
          <Text c="dimmed" size="sm">
            {fmtDate(p.birthDate)} ({p.age} р.) · {p.sex === 'male' ? 'чол.' : 'жін.'} · {p.phone ?? 'без телефону'} · група крові {p.bloodType ?? '—'}
          </Text>
          <Text c="dimmed" size="sm">
            {p.updatedAt ? `Останні зміни: ${p.updatedByEmail ?? 'система'} о ${fmtDateTime(p.updatedAt)}` : `Створено ${fmtDateTime(p.createdAt)}`}
          </Text>
        </div>
        <Group>
          {can('bookAppointment') && (
            <Button component={Link} to={`/booking?patientId=${p.id}`} variant="light">
              Записати на прийом
            </Button>
          )}
          {can('deletePatient') && (
            <Button color="red" variant="outline" loading={del.isPending} onClick={() => window.confirm(`Видалити пацієнта ${p.fullName}?`) && del.mutate({ params: { id } })}>
              Видалити
            </Button>
          )}
        </Group>
      </Group>
      <ErrorAlert error={del.error} />
      {p.insuranceCompanyName && (
        <Badge variant="light" size="lg">
          Поліс: {p.insuranceCompanyName} № {p.insurancePolicyNumber}, покриття {p.insuranceCoveragePercent}%
        </Badge>
      )}
      <Tabs defaultValue={can('patientHistory') ? 'history' : 'edit'}>
        <Tabs.List>
          {can('patientHistory') && <Tabs.Tab value="history">Медична історія</Tabs.Tab>}
          {can('patientInsurances') && <Tabs.Tab value="insurance">Страхові поліси</Tabs.Tab>}
          {can('updatePatient') && <Tabs.Tab value="edit">Редагувати</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="history" pt="md">
          <ErrorAlert error={historyQ.error} />
          {historyQ.data?.length === 0 && <Text c="dimmed">Історія порожня</Text>}
          <Timeline bulletSize={14} lineWidth={2}>
            {historyQ.data?.map((e, i) => (
              <Timeline.Item key={i} title={<Badge color={EVENT_LABEL[e.eventType]?.[1]}>{EVENT_LABEL[e.eventType]?.[0]}</Badge>}>
                <Text size="sm">{e.description}</Text>
                <Text size="xs" c="dimmed">
                  {fmtDateTime(e.eventAt)}
                  {e.doctor ? ` · ${e.doctor}` : ''}
                </Text>
              </Timeline.Item>
            ))}
          </Timeline>
        </Tabs.Panel>
        <Tabs.Panel value="insurance" pt="md">
          <Stack>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Компанія</Table.Th>
                  <Table.Th>Номер</Table.Th>
                  <Table.Th>Покриття</Table.Th>
                  <Table.Th>Термін дії</Table.Th>
                  <Table.Th>Статус</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {insurances.data?.map((i) => (
                  <Table.Tr key={i.id}>
                    <Table.Td>{i.companyName}</Table.Td>
                    <Table.Td>{i.policyNumber}</Table.Td>
                    <Table.Td>{i.coveragePercent}%</Table.Td>
                    <Table.Td>
                      {fmtDate(i.validFrom)} — {fmtDate(i.validTo)}
                    </Table.Td>
                    <Table.Td>{i.isActive ? <Badge color="green">Діє</Badge> : <Badge color="gray">Не діє</Badge>}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {can('addInsurance') && (
              <Card withBorder>
                <InsuranceForm patientId={id} />
              </Card>
            )}
          </Stack>
        </Tabs.Panel>
        {can('updatePatient') && (
          <Tabs.Panel value="edit" pt="md">
            <PatientEditForm key={p.updatedAt ?? ''} patient={p} />
          </Tabs.Panel>
        )}
      </Tabs>
    </Stack>
  );
}
