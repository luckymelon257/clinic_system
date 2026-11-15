import { randomUUID } from 'node:crypto';
import { canAccess, type CurrentUser, type RouteDef } from '@clinic/contracts';
import { RevocationStore, type RedisCtx } from '@clinic/redis';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { reads } from './db/UnitOfWork';
import { HttpError } from './errors';
import { redisCtx } from './nosql';

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET is required in production');
  return 'dev-only-secret';
}

/** Every token carries a unique `jti`, so it can be revoked on logout (F-42, BR-16). */
export function signToken(user: CurrentUser): string {
  const expiresIn = (process.env.JWT_EXPIRES_IN || '8h') as jwt.SignOptions['expiresIn'];
  return jwt.sign({ role: user.role }, secret(), { subject: String(user.id), expiresIn, jwtid: randomUUID() });
}

/** The token behind the current request: what logout needs to revoke it. */
export interface TokenInfo {
  jti: string | null;
  exp: number | null; // seconds since epoch
}

// One store per Redis handle; its process-local set keeps working while Redis is down (D-28, D-27).
let store: { ctx: RedisCtx; store: RevocationStore } | null = null;
export async function revocations(): Promise<RevocationStore> {
  const ctx = await redisCtx();
  if (store?.ctx !== ctx) store = { ctx, store: new RevocationStore(ctx) };
  return store.store;
}

/**
 * Bearer JWT → not revoked → current user re-read from v_users (so deactivation / role change applies immediately) → RBAC.
 * Returns nulls for public routes.
 */
export async function authenticate(req: Request, route: RouteDef): Promise<{ user: CurrentUser | null; token: TokenInfo }> {
  if (route.roles === 'public') return { user: null, token: { jti: null, exp: null } };
  const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (!token) throw new HttpError('UNAUTHENTICATED', 'Потрібна автентифікація');

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, secret()) as jwt.JwtPayload;
  } catch {
    throw new HttpError('UNAUTHENTICATED', 'Недійсний або прострочений токен');
  }
  const jti = typeof payload.jti === 'string' ? payload.jti : null;
  if (jti && (await (await revocations()).isRevoked(jti))) throw new HttpError('UNAUTHENTICATED', 'Сеанс завершено (токен відкликано)');

  const row = payload.sub ? await reads.users.findById(Number(payload.sub)) : null;
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
  return { user, token: { jti, exp: typeof payload.exp === 'number' ? payload.exp : null } };
}
