import { useState } from 'react';
import { Alert, Button, Card, Stack, TextInput, Title } from '@mantine/core';
import { Controller, get } from 'react-hook-form';
import { useSearchParams } from 'react-router';
import { AppointmentBookInput } from '@clinic/contracts';
import { useApiMutation } from '../api';
import { DoctorSelect, FormError, PatientPicker, SlotPicker, applyApiError, bind, fmtDateTime, useZodForm } from '../ui';

export function BookingPage() {
  const [search] = useSearchParams();
  const [booked, setBooked] = useState<{ id: number; at: string } | null>(null);
  const form = useZodForm(AppointmentBookInput, { patientId: Number(search.get('patientId')) || undefined, reason: '' });
  const book = useApiMutation('bookAppointment');
  const err = (path: string) => get(form.formState.errors, path)?.message as string | undefined;
  const submit = form.handleSubmit(async (body) => {
    try {
      const { id } = await book.mutateAsync({ body });
      setBooked({ id, at: body.startsAt });
      form.setValue('startsAt', '');
    } catch (e) {
      applyApiError(e, form);
    }
  });

  return (
    <form onSubmit={submit} noValidate>
      <Stack>
        <Title order={2}>Запис на прийом</Title>
        {booked && (
          <Alert color="green" title="Запис створено" withCloseButton onClose={() => setBooked(null)}>
            Запис №{booked.id} на {fmtDateTime(booked.at)}
          </Alert>
        )}
        <FormError message={form.formState.errors.root?.message} />
        <Card withBorder>
          <Stack>
            <Controller control={form.control} name="patientId" render={({ field }) => <PatientPicker value={field.value} onChange={field.onChange} error={err('patientId')} />} />
            <Controller
              control={form.control}
              name="doctorId"
              render={({ field }) => (
                <DoctorSelect
                  value={field.value}
                  onChange={(id) => {
                    field.onChange(id);
                    form.setValue('startsAt', '');
                  }}
                  error={err('doctorId')}
                />
              )}
            />
            <Controller
              control={form.control}
              name="startsAt"
              render={({ field }) => <SlotPicker doctorId={form.watch('doctorId')} value={field.value} onChange={field.onChange} error={err('startsAt')} />}
            />
            <TextInput label="Причина звернення" {...bind(form, 'reason')} />
          </Stack>
        </Card>
        <Button type="submit" w={200} loading={book.isPending}>
          Записати
        </Button>
      </Stack>
    </form>
  );
}
