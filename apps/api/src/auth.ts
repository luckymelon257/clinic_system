import { canAccess, type CurrentUser, type RouteDef } from '@clinic/contracts';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { reads } from './db/UnitOfWork';
import { HttpError } from './errors';

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET is required in production');
  return 'dev-only-secret';
}

export function signToken(user: CurrentUser): string {
  const expiresIn = (process.env.JWT_EXPIRES_IN || '8h') as jwt.SignOptions['expiresIn'];
  return jwt.sign({ role: user.role }, secret(), { subject: String(user.id), expiresIn });
}

/**
 * Bearer JWT → current user re-read from v_users (so deactivation / role change applies immediately) → RBAC.
 * Returns null for public routes.
 */
export async function authenticate(req: Request, route: RouteDef): Promise<CurrentUser | null> {
  if (route.roles === 'public') return null;
  const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (!token) throw new HttpError('UNAUTHENTICATED', 'Потрібна автентифікація');

  let sub: string | undefined;
  try {
    sub = (jwt.verify(token, secret()) as jwt.JwtPayload).sub;
  } catch {
    throw new HttpError('UNAUTHENTICATED', 'Недійсний або прострочений токен');
  }
  const row = sub ? await reads.users.findById(Number(sub)) : null;
  if (!row || !row.isActive) throw new HttpError('UNAUTHENTICATED', 'Користувача не знайдено або деактивовано');

  const user: CurrentUser = {
    id: row.id,
    email: row.email,
    role: row.role,
    fullName: row.fullName,
    doctorId: row.doctorId,
    patientId: row.patientId,
  };
  if (!canAccess(route, user.role)) throw new HttpError('FORBIDDEN', 'Недостатньо прав');
  return user;
}
