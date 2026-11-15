import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Group, NativeSelect, NumberInput, SegmentedControl, Stack, Table, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import type { ExposurePathResult, ExposureType, PersonKind, TraceContact, TraceResult } from '@clinic/contracts';
import { ApiError, api } from '../api';
import { PatientPicker, errorText, fmtDateTime } from '../ui';

// F-35 contact tracing and F-36 shortest exposure chain (Neo4j read model). The graph is drawn with Cytoscape.js,
// concentric layout: the index person in the centre, ring k = persons first reached at k hops.

export const EXPOSURE_LABEL: Record<ExposureType, string> = { room: 'кімната', ward: 'палата', office: 'кабінет' };
const KIND_LABEL: Record<PersonKind, string> = { patient: 'Пацієнт', staff: 'Персонал' };
// Validated categorical slots (same palette as the benchmark charts): patient = blue, staff = orange
const KIND_COLOR: Record<PersonKind, string> = { patient: '#2a78d6', staff: '#eb6834' };
const DAY = 86_400_000;
const toLocalInput = (ms: number) => new Date(ms - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const fromLocalInput = (v: string) => new Date(v).toISOString();

function graphUnavailable(err: unknown) {
  return err instanceof ApiError && err.envelope.error.code === 'GRAPH_UNAVAILABLE';
}

function GraphError({ error }: { error: unknown }) {
  if (!error) return null;
  return graphUnavailable(error) ? (
    <Alert color="orange" title="Графова база недоступна" data-testid="graph-unavailable">
      Neo4j зараз не відповідає, тож трасування контактів тимчасово неможливе. Дані в PostgreSQL не постраждали — спробуйте пізніше.
    </Alert>
  ) : (
    <Alert color="red" title="Помилка">
      {errorText(error)}
    </Alert>
  );
}

export function Freshness({ asOf, lagMs, tookMs, engine }: { asOf: string; lagMs: number; tookMs?: number; engine: string }) {
  return (
    <Text size="sm" c="dimmed" data-testid="graph-freshness">
      Дані графа станом на {fmtDateTime(asOf)}, відставання {lagMs} мс · рушій {engine}
      {tookMs !== undefined ? ` · запит ${tookMs.toFixed(1)} мс` : ''}
    </Text>
  );
}

/** Person selector: patients through the fuzzy search, staff by id. */
function PersonInput({ label, kind, id, onKind, onId }: { label: string; kind: PersonKind; id?: number; onKind: (k: PersonKind) => void; onId: (id?: number) => void }) {
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        {label}
      </Text>
      <SegmentedControl
        size="xs"
        w={220}
        value={kind}
        onChange={(v) => {
          onKind(v as PersonKind);
          onId(undefined);
        }}
        data={[
          { value: 'patient', label: 'Пацієнт' },
          { value: 'staff', label: 'Персонал' },
        ]}
      />
      {kind === 'patient' ? (
        <PatientPicker value={id} onChange={onId} />
      ) : (
        <NumberInput label="ID співробітника" min={1} w={200} value={id ?? ''} onChange={(v) => onId(typeof v === 'number' ? v : undefined)} />
      )}
    </Stack>
  );
}

/** Cytoscape canvas; loaded lazily (keeps the main bundle small) and skipped where canvas is unavailable (jsdom). */
function ContactGraph({ result }: { result: TraceResult }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let destroyed = false;
    let cy: { destroy(): void } | null = null;
    const el = ref.current;
    if (!el || typeof HTMLCanvasElement === 'undefined' || !HTMLCanvasElement.prototype.getContext || /jsdom/i.test(navigator.userAgent)) return;
    void import('cytoscape')
      .then(({ default: cytoscape }) => {
        if (destroyed) return;
        const idx = `${result.index.kind}:${result.index.id}`;
        const maxHops = Math.max(1, ...result.contacts.map((c) => c.hops));
        // short labels keep rings readable: "Шевченко Т. Г."
        const short = (n: string) => n.split(' ').map((w, i) => (i === 0 || w.startsWith('(') ? w : `${w[0]}.`)).join(' ');
        cy = cytoscape({
          container: el,
          elements: [
            { data: { id: idx, label: short(result.index.name), kind: result.index.kind, hops: 0 } },
            ...result.contacts.map((c) => ({ data: { id: `${c.kind}:${c.id}`, label: short(c.name), kind: c.kind, hops: c.hops } })),
            ...result.contacts.map((c) => ({
              data: { id: `e-${c.kind}:${c.id}`, source: `${c.parentKind}:${c.parentId}`, target: `${c.kind}:${c.id}`, label: EXPOSURE_LABEL[c.exposure] },
            })),
          ],
          style: [
            { selector: 'node', style: { label: 'data(label)', 'font-size': 10, color: '#1f1f1d', 'text-valign': 'bottom', 'text-margin-y': 4, width: 18, height: 18, 'border-width': 2, 'border-color': '#fcfcfb' } },
            { selector: 'node[kind = "patient"]', style: { 'background-color': KIND_COLOR.patient, shape: 'ellipse' } },
            { selector: 'node[kind = "staff"]', style: { 'background-color': KIND_COLOR.staff, shape: 'round-rectangle' } },
            { selector: 'node[hops = 0]', style: { width: 30, height: 30, 'border-color': '#1f1f1d', 'font-weight': 'bold' } },
            { selector: 'edge', style: { width: 1.5, 'line-color': '#b9b8b0', 'target-arrow-shape': 'triangle', 'target-arrow-color': '#b9b8b0', 'curve-style': 'bezier', label: 'data(label)', 'font-size': 8, color: '#6b6a63', 'text-rotation': 'autorotate' } },
          ],
          layout: { name: 'concentric', concentric: (n: { data(k: string): number }) => maxHops + 1 - n.data('hops'), levelWidth: () => 1, minNodeSpacing: 60, spacingFactor: 1.2, animate: false },
          maxZoom: 1.6,
          minZoom: 0.2,
          wheelSensitivity: 0.3,
        });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      destroyed = true;
      cy?.destroy();
    };
  }, [result]);
  return (
    <Stack gap={4}>
      <Group gap="md">
        {(['patient', 'staff'] as const).map((k) => (
          <Group key={k} gap={6}>
            <span style={{ display: 'inline-block', width: 12, height: 12, background: KIND_COLOR[k], borderRadius: k === 'patient' ? 6 : 3 }} />
            <Text size="xs">{KIND_LABEL[k]}</Text>
          </Group>
        ))}
        <Text size="xs" c="dimmed">
          кільця — кількість кроків від індексної особи (у центрі); підпис ребра — місце контакту
        </Text>
      </Group>
      <div ref={ref} data-testid="trace-graph" data-nodes={result.contacts.length + 1} style={{ height: 460, border: '1px solid var(--mantine-color-gray-3)', borderRadius: 8, background: '#fcfcfb' }} />
      {error && <Text c="red">Не вдалося намалювати граф: {error}</Text>}
    </Stack>
  );
}

function ContactTable({ contacts, index }: { contacts: TraceContact[]; index: TraceResult['index'] }) {
  const [asc, setAsc] = useState(true);
  const names = useMemo(() => new Map([[`${index.kind}:${index.id}`, index.name], ...contacts.map((c) => [`${c.kind}:${c.id}`, c.name] as const)]), [contacts, index]);
  const rows = useMemo(() => [...contacts].sort((a, b) => (asc ? a.hops - b.hops : b.hops - a.hops) || a.name.localeCompare(b.name, 'uk')), [contacts, asc]);
  return (
    <Table striped data-testid="trace-table">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>
            <UnstyledButton onClick={() => setAsc((v) => !v)} aria-label="Сортувати за кроками">
              Кроків {asc ? '↑' : '↓'}
            </UnstyledButton>
          </Table.Th>
          <Table.Th>Особа</Table.Th>
          <Table.Th>Тип</Table.Th>
          <Table.Th>Від кого (крок раніше)</Table.Th>
          <Table.Th>Місце</Table.Th>
          <Table.Th>Перетин, хв</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((c) => (
          <Table.Tr key={`${c.kind}:${c.id}`}>
            <Table.Td>{c.hops}</Table.Td>
            <Table.Td>{c.name}</Table.Td>
            <Table.Td>
              <Badge variant="light" color={c.kind === 'patient' ? 'blue' : 'orange'}>
                {c.kind === 'staff' ? (c.role === 'doctor' ? 'Лікар' : 'Медсестра') : 'Пацієнт'}
              </Badge>
            </Table.Td>
            <Table.Td>{names.get(`${c.parentKind}:${c.parentId}`) ?? `#${c.parentId}`}</Table.Td>
            <Table.Td>
              {c.placeName ?? `#${c.placeId}`}{' '}
              <Text span size="xs" c="dimmed">
                ({EXPOSURE_LABEL[c.exposure]})
              </Text>
            </Table.Td>
            <Table.Td>{c.overlapMinutes.toLocaleString('uk-UA')}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function PathView({ result }: { result: ExposurePathResult }) {
  if (!result.found)
    return (
      <Alert color="gray" data-testid="path-result">
        Особи не повʼязані в межах заданої глибини й вікна.
      </Alert>
    );
  return (
    <Stack gap="xs" data-testid="path-result">
      <Text fw={600}>Ланцюг із {result.hops} кроків:</Text>
      <Group gap="xs">
        {result.steps.map((s, i) =>
          s.type === 'person' ? (
            <Badge key={i} size="lg" variant="filled" color={s.kind === 'patient' ? 'blue' : 'orange'}>
              {s.name}
            </Badge>
          ) : (
            <Text key={i} size="sm" c="dimmed">
              → {s.name ?? `${EXPOSURE_LABEL[s.kind]} #${s.id}`} ({fmtDateTime(s.from)}–{fmtDateTime(s.to)}) →
            </Text>
          ),
        )}
      </Group>
      <Freshness asOf={result.asOf} lagMs={result.lagMs} engine={result.engine} />
    </Stack>
  );
}

export function TracingPage() {
  const now = Date.now();
  const [from, setFrom] = useState(toLocalInput(now - 14 * DAY));
  const [to, setTo] = useState(toLocalInput(now));
  const [depth, setDepth] = useState('2');
  const [kind, setKind] = useState<PersonKind>('patient');
  const [personId, setPersonId] = useState<number | undefined>();
  const [bKind, setBKind] = useState<PersonKind>('patient');
  const [bId, setBId] = useState<number | undefined>();
  const [trace, setTrace] = useState<TraceResult | null>(null);
  const [path, setPath] = useState<ExposurePathResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<'trace' | 'path' | null>(null);
  const windowDays = (Date.parse(to) - Date.parse(from)) / DAY;
  const windowError = !(windowDays > 0) ? 'Кінець вікна має бути пізніше за початок' : windowDays > 90 ? 'Вікно не довше 90 днів' : null;

  const run = async (what: 'trace' | 'path') => {
    setBusy(what);
    setError(null);
    try {
      if (what === 'trace') {
        setTrace(await api('traceContacts', { query: { personKind: kind, personId: personId!, from: fromLocalInput(from), to: fromLocalInput(to), depth: Number(depth) } }));
      } else {
        setPath(await api('exposurePath', { query: { aKind: kind, aId: personId!, bKind, bId: bId!, from: fromLocalInput(from), to: fromLocalInput(to) } }));
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack>
      <Title order={2}>Відстеження контактів</Title>
      <Card withBorder>
        <Stack>
          <PersonInput label="Індексна особа" kind={kind} id={personId} onKind={setKind} onId={setPersonId} />
          <Group align="flex-end">
            <TextInput type="datetime-local" label="Вікно від" value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
            <TextInput type="datetime-local" label="до" value={to} onChange={(e) => setTo(e.currentTarget.value)} error={windowError} />
            <NativeSelect label="Глибина" w={110} value={depth} onChange={(e) => setDepth(e.currentTarget.value)} data={['1', '2', '3', '4', '5']} />
            <Button onClick={() => void run('trace')} loading={busy === 'trace'} disabled={!personId || !!windowError}>
              Трасувати
            </Button>
          </Group>
        </Stack>
      </Card>

      <GraphError error={error} />

      {trace && (
        <Card withBorder data-testid="trace-result">
          <Stack>
            <Group justify="space-between">
              <Title order={4}>
                {trace.index.name}: {trace.contacts.length} контактів до {trace.depth} кроків
              </Title>
              <Freshness asOf={trace.asOf} lagMs={trace.lagMs} tookMs={trace.tookMs} engine={trace.engine} />
            </Group>
            {trace.contacts.length ? (
              <>
                <ContactGraph result={trace} />
                <ContactTable contacts={trace.contacts} index={trace.index} />
              </>
            ) : (
              <Text c="dimmed">У вікні контактів не знайдено.</Text>
            )}
          </Stack>
        </Card>
      )}

      <Card withBorder>
        <Stack>
          <Title order={4}>Найкоротший ланцюг експозиції</Title>
          <Text size="sm" c="dimmed">
            Від індексної особи (вище) до особи B у тому самому вікні.
          </Text>
          <PersonInput label="Особа B" kind={bKind} id={bId} onKind={setBKind} onId={setBId} />
          <Button w={220} onClick={() => void run('path')} loading={busy === 'path'} disabled={!personId || !bId || !!windowError}>
            Знайти ланцюг
          </Button>
          {path && <PathView result={path} />}
        </Stack>
      </Card>
    </Stack>
  );
}
