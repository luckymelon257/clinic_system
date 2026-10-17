import { Button, Center, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { LoginInput } from '@clinic/contracts';
import { api, setToken } from '../api';
import { FormError, applyApiError, bind, useZodForm } from '../ui';

export function LoginPage() {
  const form = useZodForm(LoginInput, { email: '', password: '' });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const submit = form.handleSubmit(async (body) => {
    try {
      const res = await api('login', { body });
      setToken(res.token);
      qc.setQueryData(['me', undefined], res.user);
      navigate('/', { replace: true });
    } catch (e) {
      applyApiError(e, form);
    }
  });
  return (
    <Center h="100vh" bg="gray.0">
      <Paper withBorder shadow="sm" p="xl" w={380}>
        <form onSubmit={submit} noValidate>
          <Stack>
            <Title order={3}>Вхід до системи лікарні</Title>
            <FormError message={form.formState.errors.root?.message} />
            <TextInput label="Email" type="email" autoComplete="username" {...bind(form, 'email')} />
            <PasswordInput label="Пароль" autoComplete="current-password" {...bind(form, 'password')} />
            <Button type="submit" loading={form.formState.isSubmitting}>
              Увійти
            </Button>
            <Text size="xs" c="dimmed">
              Демо: doctor@clinic.local / doctor123 (також admin, registrar, lab, cashier, patient)
            </Text>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
