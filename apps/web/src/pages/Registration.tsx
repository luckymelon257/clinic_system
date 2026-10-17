import { useState } from 'react';
import { Alert, Anchor, Button, Card, Checkbox, Stack, TextInput, Title } from '@mantine/core';
import { Controller, get } from 'react-hook-form';
import { Link } from 'react-router';
import { z } from 'zod';
import { RegistrationInput, type RegistrationResult } from '@clinic/contracts';
import { useApi, useApiMutation } from '../api';
import { DoctorSelect, FormError, SlotPicker, applyApiError, bind, today, useZodForm } from '../ui';
import { InsuranceFields, PatientFields, emptyPatient } from './Patients';

// The two checkboxes only decide whether the optional parts are sent; zod strips them from the output.
const RegistrationForm = RegistrationInput.extend({ withInsurance: z.boolean(), withAppointment: z.boolean() });

export function RegistrationPage() {
  const companies = useApi('listInsuranceCompanies');
  const [result, setResult] = useState<RegistrationResult | null>(null);
  const form = useZodForm(
    RegistrationForm,
    { patient: emptyPatient, withInsurance: false, withAppointment: false, insurance: { policyNumber: '', validFrom: today(), validTo: '' } },
    (v) => ({ ...v, insurance: v.withInsurance ? v.insurance : null, appointment: v.withAppointment ? v.appointment : null }),
  );
  const register = useApiMutation('register', setResult);
  const submit = form.handleSubmit(({ withInsurance: _i, withAppointment: _a, ...body }) => register.mutateAsync({ body }).catch((e) => applyApiError(e, form)));
  const err = (path: string) => get(form.formState.errors, path)?.message as string | undefined;

  if (result)
    return (
      <Stack>
        <Alert color="green" title="Пацієнта зареєстровано">
          Пацієнт №{result.patientId}
          {result.insuranceId && `, поліс №${result.insuranceId}`}
          {result.appointmentId && `, запис на прийом №${result.appointmentId}`}.{' '}
          <Anchor component={Link} to={`/patients/${result.patientId}`}>
            Відкрити картку
          </Anchor>
        </Alert>
        <Button
          variant="light"
          w={240}
          onClick={() => {
            form.reset();
            setResult(null);
          }}
        >
          Зареєструвати ще одного
        </Button>
      </Stack>
    );

  return (
    <form onSubmit={submit} noValidate>
      <Stack>
        <Title order={2}>Реєстрація пацієнта</Title>
        <FormError message={form.formState.errors.root?.message} />
        <Card withBorder>
          <PatientFields form={form as never} p="patient." />
        </Card>
        <Checkbox label="Додати страховий поліс" {...form.register('withInsurance')} />
        {form.watch('withInsurance') && (
          <Card withBorder>
            <InsuranceFields form={form as never} p="insurance." companies={companies.data ?? []} />
          </Card>
        )}
        <Checkbox label="Одразу записати на прийом" {...form.register('withAppointment')} />
        {form.watch('withAppointment') && (
          <Card withBorder>
            <Stack>
              <Controller
                control={form.control}
                name="appointment.doctorId"
                render={({ field }) => <DoctorSelect value={field.value} onChange={field.onChange} error={err('appointment.doctorId')} />}
              />
              <Controller
                control={form.control}
                name="appointment.startsAt"
                render={({ field }) => <SlotPicker doctorId={form.watch('appointment.doctorId')} value={field.value} onChange={field.onChange} error={err('appointment.startsAt')} />}
              />
              <TextInput label="Причина звернення" {...bind(form, 'appointment.reason')} />
            </Stack>
          </Card>
        )}
        <Button type="submit" w={240} loading={register.isPending}>
          Зареєструвати
        </Button>
      </Stack>
    </form>
  );
}
