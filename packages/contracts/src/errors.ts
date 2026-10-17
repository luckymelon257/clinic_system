import { z } from 'zod';

/**
 * Every non-2xx response has this body.
 *
 * Status policy:
 *   400 VALIDATION_ERROR  zod failure (details = issues[]), bad table name, malformed data (SQLSTATE 22xxx)
 *   401 UNAUTHENTICATED   no / invalid / expired JWT, wrong credentials
 *   403 FORBIDDEN         role not in route.roles, or SQLSTATE P0403
 *   404 NOT_FOUND         unknown route / row missing in view / SQLSTATE P0002
 *   409 CONFLICT          23505 unique, 23P01 exclusion (overlapping slot / bed), P0409
 *   422 BUSINESS_RULE     any other P0xxx, 23503 FK, 23514 CHECK, 23502 NOT NULL
 *   500 INTERNAL          everything else (message is generic, never leaks SQL)
 */
export const ErrorCode = z.enum([
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'BUSINESS_RULE',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const FieldIssue = z.object({ path: z.string(), message: z.string() });
export type FieldIssue = z.infer<typeof FieldIssue>;

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(), // human readable, Ukrainian for business rules (comes from RAISE EXCEPTION)
    sqlstate: z.string().optional(),
    constraint: z.string().optional(), // PG constraint name for 409/422, lets the UI pick a field
    issues: z.array(FieldIssue).optional(), // only for VALIDATION_ERROR
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export const statusForCode: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  BUSINESS_RULE: 422,
  INTERNAL: 500,
};

/**
 * Custom SQLSTATEs raised by the database (RAISE ... USING ERRCODE = 'P0xxx').
 * Business rules use P0001..P0099; the three below have special HTTP meaning.
 */
export const SqlState = {
  NotFound: 'P0002',
  Forbidden: 'P0403',
  Conflict: 'P0409',
} as const;

export function errorCodeForSqlState(sqlstate: string | undefined): ErrorCode {
  if (!sqlstate) return 'INTERNAL';
  if (sqlstate === SqlState.NotFound) return 'NOT_FOUND';
  if (sqlstate === SqlState.Forbidden) return 'FORBIDDEN';
  if (sqlstate === SqlState.Conflict || sqlstate === '23505' || sqlstate === '23P01') return 'CONFLICT';
  if (sqlstate.startsWith('P0')) return 'BUSINESS_RULE';
  if (['23503', '23514', '23502'].includes(sqlstate)) return 'BUSINESS_RULE';
  if (sqlstate.startsWith('22')) return 'VALIDATION_ERROR';
  return 'INTERNAL';
}
