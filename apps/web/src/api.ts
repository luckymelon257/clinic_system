import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ErrorEnvelope,
  buildPath,
  routes,
  type RouteBodyIn,
  type RouteDef,
  type RouteName,
  type RouteOutput,
  type RouteParamsIn,
  type RouteQueryIn,
} from '@clinic/contracts';

// A slot is required when the schema has required keys, optional when everything defaults / is absent.
type Slot<K extends string, T> = [T] extends [undefined] ? { [P in K]?: undefined } : object extends T ? { [P in K]?: T } : { [P in K]: T };
export type ApiInput<N extends RouteName> = Slot<'params', RouteParamsIn<N>> & Slot<'query', RouteQueryIn<N>> & Slot<'body', RouteBodyIn<N>>;
type ApiArgs<N extends RouteName> = object extends ApiInput<N> ? [input?: ApiInput<N>] : [input: ApiInput<N>];

export class ApiError extends Error {
  readonly status: number;
  readonly envelope: ErrorEnvelope;
  constructor(status: number, envelope: ErrorEnvelope) {
    super(envelope.error.message);
    this.status = status;
    this.envelope = envelope;
  }
}

const TOKEN_KEY = 'clinic.token';
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/** Typed call of a contract route: `api('getPatient', { params: { id } })`. */
export async function api<N extends RouteName>(name: N, ...[input]: ApiArgs<N>): Promise<RouteOutput<N>> {
  const route: RouteDef = routes[name];
  const { params, query, body } = (input ?? {}) as { params?: Record<string, string | number>; query?: Record<string, unknown>; body?: unknown };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const search = qs.toString();
  const url = (import.meta.env.VITE_API_URL ?? '') + buildPath(route.path, params) + (search ? `?${search}` : '');
  const token = getToken();
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { method: route.method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && route.roles !== 'public') {
      clearToken();
      window.location.assign('/login');
    }
    const env = ErrorEnvelope.safeParse(data);
    throw new ApiError(res.status, env.success ? env.data : { error: { code: 'INTERNAL', message: `Помилка сервера (${res.status})` } });
  }
  return data as RouteOutput<N>;
}

export function useApi<N extends RouteName>(name: N, input?: ApiInput<N>, enabled = true) {
  return useQuery({ queryKey: [name, input], queryFn: () => api(name, ...([input] as ApiArgs<N>)), enabled });
}

/** Mutation of a contract route; on success every query is invalidated (data is small, correctness wins). */
export function useApiMutation<N extends RouteName>(name: N, onSuccess?: (data: RouteOutput<N>) => void) {
  const qc = useQueryClient();
  return useMutation<RouteOutput<N>, ApiError, ApiInput<N>>({
    mutationFn: (input) => api(name, ...([input] as ApiArgs<N>)),
    onSuccess: (data) => {
      void qc.invalidateQueries();
      onSuccess?.(data);
    },
  });
}

export const useMe = () => useApi('me', undefined, !!getToken());
