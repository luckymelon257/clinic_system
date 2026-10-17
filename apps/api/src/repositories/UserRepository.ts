import type { Role, RouteQuery, User } from '@clinic/contracts';
import { BaseRepository, type Page } from '../db/BaseRepository';

export type AuthUser = {
  id: number;
  email: string;
  role: Role;
  fullName: string;
  passwordHash: string;
  isActive: boolean;
  doctorId: number | null;
  patientId: number | null;
};
export type UserRow = User & { doctorId: number | null; patientId: number | null };

export class UserRepository extends BaseRepository {
  authByEmail(email: string) {
    return this.one<AuthUser>('SELECT * FROM fn_auth_user($1)', [email]);
  }

  findById(id: number) {
    return this.one<UserRow>('SELECT * FROM v_users WHERE id = $1', [id]);
  }

  async list(q: RouteQuery<'listUsers'>): Promise<Page<User>> {
    const total = await this.one<{ n: number }>('SELECT count(*)::int AS n FROM v_users');
    const items = await this.many<User>('SELECT * FROM v_users ORDER BY id LIMIT $1 OFFSET $2', [q.limit, q.offset]);
    return { items, total: total?.n ?? 0 };
  }

  touchLogin(id: number) {
    return this.call('sp_user_touch_login', [id]);
  }

  create(email: string, passwordHash: string, role: Role, fullName: string) {
    return this.callReturningId('sp_user_create', [email, passwordHash, role, fullName]);
  }

  setActive(id: number, isActive: boolean) {
    return this.call('sp_user_set_active', [id, isActive]);
  }
}
