import { errorCodeForSqlState, statusForCode, type ErrorCode, type ErrorEnvelope, type FieldIssue } from '@clinic/contracts';
import pg from 'pg';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Запис не знайдено') => new HttpError('NOT_FOUND', what);

/** Any thrown value → [HTTP status, ErrorEnvelope]. */
export function toErrorResponse(e: unknown): [number, ErrorEnvelope] {
  const env = (error: ErrorEnvelope['error']): [number, ErrorEnvelope] => [statusForCode[error.code], { error }];

  if (e instanceof ZodError) {
    const issues: FieldIssue[] = e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return env({ code: 'VALIDATION_ERROR', message: 'Помилка валідації', issues });
  }
  if (e instanceof HttpError) return env({ code: e.code, message: e.message });
  if (e instanceof pg.DatabaseError) {
    const code = errorCodeForSqlState(e.code);
    if (code === 'INTERNAL') return env({ code, message: 'Внутрішня помилка сервера', sqlstate: e.code });
    return env({ code, message: e.message, sqlstate: e.code, ...(e.constraint ? { constraint: e.constraint } : {}) });
  }
  // body-parser: malformed JSON / too large
  const status = (e as { status?: number })?.status;
  if (status === 400 || status === 413) return env({ code: 'VALIDATION_ERROR', message: 'Некоректне тіло запиту' });
  return env({ code: 'INTERNAL', message: 'Внутрішня помилка сервера' });
}
