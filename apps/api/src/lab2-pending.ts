import type { ErrorCode, RouteName, RouteOutput } from '@clinic/contracts';
import { HttpError } from './errors';

// Placeholder: the Lab 2 routes exist in the contract; handlers are added separately.
// Remove an entry here when its real handler lands in handlers.ts.
type Lab2Route =
  | 'logout' | 'health' | 'traceContacts' | 'exposurePath' | 'checkInteractions' | 'triageList' | 'triageAdd'
  | 'triageCallNext' | 'bedCounts' | 'icuBeds' | 'icuAlerts' | 'icuStream';

const pending = (code: ErrorCode) => async (): Promise<never> => {
  throw new HttpError(code, 'Ще не реалізовано (Лаб 2)');
};

export const lab2Pending: { [N in Lab2Route]: () => Promise<RouteOutput<N>> } = {
  logout: pending('INTERNAL'),
  health: pending('INTERNAL'),
  traceContacts: pending('GRAPH_UNAVAILABLE'),
  exposurePath: pending('GRAPH_UNAVAILABLE'),
  checkInteractions: pending('GRAPH_UNAVAILABLE'),
  triageList: pending('QUEUE_UNAVAILABLE'),
  triageAdd: pending('QUEUE_UNAVAILABLE'),
  triageCallNext: pending('QUEUE_UNAVAILABLE'),
  bedCounts: pending('INTERNAL'),
  icuBeds: pending('INTERNAL'),
  icuAlerts: pending('INTERNAL'),
  icuStream: pending('INTERNAL'),
} satisfies Record<Lab2Route, unknown> & Partial<Record<RouteName, unknown>>;
