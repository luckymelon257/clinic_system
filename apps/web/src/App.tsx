import { useState, type ReactNode } from 'react';
import { AppShell, Alert, Badge, Button, Center, Group, Loader, MantineProvider, NavLink, Text, Title, Tooltip } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { NavLink as RouterLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router';
import { canAccess, routes, type RouteName } from '@clinic/contracts';
import { api, clearToken, getToken, useApi, useMe } from './api';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { PatientCardPage, PatientSearchPage } from './pages/Patients';
import { RegistrationPage } from './pages/Registration';
import { BookingPage } from './pages/Booking';
import { DoctorDayPage, VisitPage } from './pages/Doctor';
import { LabPage } from './pages/Lab';
import { InpatientPage } from './pages/Inpatient';
import { InvoiceDetailPage, InvoicesPage, RevenuePage } from './pages/Finance';
import { AuditPage, DeletedPage } from './pages/Admin';
import { TracingPage } from './pages/Tracing';
import { IcuPage } from './pages/Icu';
import { TriagePage } from './pages/Triage';

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }));
  return (
    <MantineProvider>
      <Notifications />
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineProvider>
  );
}

// Every page is gated by the contract route it depends on; the menu shows only what the role may call.
const PAGES: { path: string; route: RouteName; el: ReactNode; label?: string }[] = [
  { path: '/', route: 'me', el: <DashboardPage />, label: 'Головна' },
  { path: '/patients', route: 'searchPatients', el: <PatientSearchPage />, label: 'Пацієнти' },
  { path: '/patients/:id', route: 'getPatient', el: <PatientCardPage /> },
  { path: '/registration', route: 'register', el: <RegistrationPage />, label: 'Реєстрація' },
  { path: '/booking', route: 'bookAppointment', el: <BookingPage />, label: 'Запис на прийом' },
  { path: '/doctor', route: 'completeVisit', el: <DoctorDayPage />, label: 'Прийоми лікаря' },
  { path: '/visit/:id', route: 'completeVisit', el: <VisitPage /> },
  { path: '/lab', route: 'labQueue', el: <LabPage />, label: 'Лабораторія' },
  { path: '/inpatient', route: 'listBeds', el: <InpatientPage />, label: 'Стаціонар' },
  { path: '/triage', route: 'triageList', el: <TriagePage />, label: 'Тріаж' },
  { path: '/icu', route: 'icuBeds', el: <IcuPage />, label: 'Монітор ВІТ' },
  { path: '/tracing', route: 'traceContacts', el: <TracingPage />, label: 'Відстеження контактів' },
  { path: '/invoices', route: 'listInvoices', el: <InvoicesPage />, label: 'Рахунки' },
  { path: '/invoices/:id', route: 'getInvoice', el: <InvoiceDetailPage /> },
  { path: '/revenue', route: 'revenue', el: <RevenuePage />, label: 'Виручка' },
  { path: '/audit', route: 'auditLog', el: <AuditPage />, label: 'Журнал аудиту' },
  { path: '/deleted', route: 'deletedRecords', el: <DeletedPage />, label: 'Видалені записи' },
];

const ROLE_LABEL: Record<string, string> = {
  admin: 'Адміністратор',
  registrar: 'Реєстратор',
  doctor: 'Лікар',
  lab_technician: 'Лаборант',
  cashier: 'Касир',
  patient: 'Пацієнт',
};

const ENGINE_STATUS: Record<string, [string, string]> = { up: ['працює', 'green'], degraded: ['частково', 'yellow'], down: ['недоступно', 'red'] };

/** F-45: PostgreSQL / Neo4j / Redis status and graph sync lag in the header. */
function HealthBadge() {
  const h = useApi('health').data;
  if (!h) return null;
  const line = (name: string, e: { status: string; latencyMs: number | null }) =>
    `${name}: ${ENGINE_STATUS[e.status]?.[0] ?? e.status}${e.latencyMs !== null ? ` (${e.latencyMs.toFixed(1)} мс)` : ''}`;
  const tip = [line('PostgreSQL', h.postgres), line('Neo4j', h.neo4j), line('Redis', h.redis), `Відставання графа: ${h.graphSync.lagMs ?? '—'} мс`].join(' · ');
  return (
    <Tooltip label={tip} multiline w={320}>
      <Badge variant="dot" color={ENGINE_STATUS[h.status]?.[1] ?? 'gray'} data-testid="health-badge">
        Системи: {ENGINE_STATUS[h.status]?.[0] ?? h.status}
      </Badge>
    </Tooltip>
  );
}

function Layout() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  if (!getToken()) return <Navigate to="/login" replace />;
  if (me.isLoading)
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  if (!me.data) return <Navigate to="/login" replace />;
  const role = me.data.role;
  const logout = async () => {
    await api('logout').catch(() => undefined); // revoke the JWT server-side (BR-16); leave anyway if it fails
    clearToken();
    qc.clear();
    navigate('/login');
  };
  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 230, breakpoint: 'sm' }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Title order={4}>Лікарня</Title>
          <Group>
            <HealthBadge />
            <Text size="sm">
              {me.data.fullName} · {ROLE_LABEL[role]}
            </Text>
            <Button size="xs" variant="default" onClick={() => void logout()}>
              Вийти
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        {PAGES.filter((p) => p.label && canAccess(routes[p.route], role)).map((p) => (
          <NavLink key={p.path} component={RouterLink} to={p.path} label={p.label} active={p.path === '/' ? pathname === '/' : pathname.startsWith(p.path)} />
        ))}
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}

function Guard({ route, children }: { route: RouteName; children: ReactNode }) {
  const me = useMe();
  return canAccess(routes[route], me.data?.role ?? null) ? children : <Alert color="red">Недостатньо прав</Alert>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Layout />}>
        {PAGES.map((p) => (
          <Route key={p.path} path={p.path} element={<Guard route={p.route}>{p.el}</Guard>} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
