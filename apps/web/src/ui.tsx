import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Badge, Button, Group, NativeSelect, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { get, useForm, type DefaultValues, type FieldValues, type Path, type RegisterOptions, type Resolver, type UseFormReturn } from 'react-hook-form';
import { z } from 'zod';
import { ApiError, useApi } from './api';

// Missing required values ('' is turned into undefined below) get the same text the contract uses.
z.config({ customError: (iss) => (iss.code === 'invalid_type' && iss.input === undefined ? 'Обовʼязкове поле' : undefined) });

/** '' and NaN (empty <input type=number>) → undefined, so optional contract fields validate as "absent". */
const clean = (v: unknown): unknown =>
  v === '' || (typeof v === 'number' && Number.isNaN(v))
    ? undefined
    : Array.isArray(v)
      ? v.map(clean)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]))
        : v;

/** react-hook-form wired to a contract zod schema. `prepare` may reshape values before validation. */
export function useZodForm<S extends z.ZodType<FieldValues, FieldValues>>(
  schema: S,
  defaultValues?: DefaultValues<z.input<S>>,
  prepare: (v: z.input<S>) => unknown = (v) => v,
) {
  const resolver = zodResolver(schema) as unknown as Resolver<FieldValues, unknown, z.output<S>>;
  return useForm<z.input<S>, unknown, z.output<S>>({
    defaultValues,
    resolver: (values, ctx, opts) => resolver(clean(prepare(values)) as FieldValues, ctx, opts as never) as never,
  });
}

/** register() + Mantine `error` prop in one spread. */
export function bind<T extends FieldValues>(form: UseFormReturn<T, unknown, unknown>, name: Path<T>, opts?: RegisterOptions<T, Path<T>>) {
  return { ...form.register(name, opts), error: get(form.formState.errors, name)?.message as string | undefined };
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.status === 403 ? 'Недостатньо прав' : err.message;
  return err instanceof Error ? err.message : 'Невідома помилка';
}

/** 400 issues → field errors; everything else → root form error (Ukrainian message from the API). */
export function applyApiError<T extends FieldValues>(err: unknown, form: UseFormReturn<T, unknown, unknown>) {
  const issues = err instanceof ApiError && err.status === 400 ? (err.envelope.error.issues ?? []) : [];
  for (const i of issues) form.setError(i.path as Path<T>, { message: i.message });
  if (!issues.length) form.setError('root', { message: errorText(err) });
}

export function FormError({ message }: { message?: string }) {
  return message ? (
    <Alert color="red" title="Помилка">
      {message}
    </Alert>
  ) : null;
}

export function ErrorAlert({ error }: { error: unknown }) {
  return error ? (
    <Alert color="red" title="Помилка">
      {errorText(error)}
    </Alert>
  ) : null;
}

export const fmtDateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
export const fmtDate = (d: string | null) => (d ? new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString('uk-UA') : '—');
export const money = (n: number) => `${n.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} грн`;
export const today = () => new Date().toLocaleDateString('sv-SE');

export const APPT_STATUS: Record<string, [string, string]> = {
  scheduled: ['Заплановано', 'blue'],
  confirmed: ['Підтверджено', 'cyan'],
  in_progress: ['Триває', 'orange'],
  completed: ['Завершено', 'green'],
  cancelled: ['Скасовано', 'gray'],
  no_show: ['Не зʼявився', 'red'],
};
export const INVOICE_STATUS: Record<string, [string, string]> = {
  draft: ['Чернетка', 'gray'],
  issued: ['Виставлено', 'blue'],
  partially_paid: ['Частково оплачено', 'orange'],
  paid: ['Оплачено', 'green'],
  cancelled: ['Скасовано', 'gray'],
};
export const PAYMENT_METHOD: Record<string, string> = { cash: 'Готівка', card: 'Картка', bank_transfer: 'Переказ', insurance: 'Страховка' };
export const StatusBadge = ({ map, value }: { map: Record<string, [string, string]>; value: string }) => (
  <Badge color={map[value]?.[1] ?? 'gray'} variant="light">
    {map[value]?.[0] ?? value}
  </Badge>
);

export function DoctorSelect({ value, onChange, error }: { value?: number | null; onChange: (id: number | undefined) => void; error?: string }) {
  const doctors = useApi('listDoctors');
  return (
    <NativeSelect
      label="Лікар"
      error={error}
      value={value ? String(value) : ''}
      onChange={(e) => onChange(e.currentTarget.value ? Number(e.currentTarget.value) : undefined)}
      data={[{ value: '', label: '— оберіть лікаря —' }, ...(doctors.data ?? []).map((d) => ({ value: String(d.id), label: `${d.fullName} (${d.specializationName})` }))]}
    />
  );
}

/** Debounced fuzzy search + select of the found patients. */
export function PatientPicker({ value, onChange, error }: { value?: number | null; onChange: (id: number | undefined) => void; error?: string }) {
  const [q, setQ] = useState('');
  const [dq] = useDebouncedValue(q, 300);
  const found = useApi('searchPatients', { query: { q: dq } });
  const list = found.data ?? [];
  const selected = useApi('getPatient', { params: { id: value ?? 0 } }, !!value && !list.some((p) => p.id === value));
  const options = selected.data && !list.some((p) => p.id === value) ? [selected.data, ...list] : list;
  return (
    <Group grow align="flex-start">
      <TextInput label="Пошук пацієнта" placeholder="ПІБ або телефон" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
      <NativeSelect
        label="Пацієнт"
        error={error}
        value={value ? String(value) : ''}
        onChange={(e) => onChange(e.currentTarget.value ? Number(e.currentTarget.value) : undefined)}
        data={[{ value: '', label: '— оберіть пацієнта —' }, ...options.map((p) => ({ value: String(p.id), label: `${p.fullName}, ${fmtDate(p.birthDate)}` }))]}
      />
    </Group>
  );
}

/** Date + free-slot buttons for a doctor (freeSlots). `value` is slotStart. */
export function SlotPicker({ doctorId, value, onChange, error }: { doctorId?: number | null; value?: string; onChange: (slotStart: string) => void; error?: string }) {
  const [date, setDate] = useState(today());
  const slots = useApi('freeSlots', { params: { id: doctorId ?? 0 }, query: { date } }, !!doctorId && !!date);
  return (
    <Stack gap="xs">
      <TextInput type="date" label="Дата" value={date} onChange={(e) => setDate(e.currentTarget.value)} w={200} />
      {!doctorId ? (
        <Text c="dimmed">Спершу оберіть лікаря</Text>
      ) : slots.isLoading ? (
        <Text c="dimmed">Завантаження слотів…</Text>
      ) : slots.data?.length ? (
        <Group gap="xs">
          {slots.data.map((s) => (
            <Button key={s.slotStart} size="xs" variant={value === s.slotStart ? 'filled' : 'outline'} onClick={() => onChange(s.slotStart)}>
              {fmtTime(s.slotStart)}
            </Button>
          ))}
        </Group>
      ) : (
        <Text c="dimmed">Немає вільних слотів на цю дату</Text>
      )}
      {error && (
        <Text c="red" size="sm">
          {error}
        </Text>
      )}
    </Stack>
  );
}
