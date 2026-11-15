import { key, keys, type RedisCtx } from './client';

// F-42 / BR-16 / D-27: one key per revoked JWT id with its own TTL = remaining token lifetime
// (members of a SET cannot expire individually). D-28: when Redis is down the check FAILS OPEN (the token is
// accepted unless THIS process revoked it — kept in a process-local map until the token would expire anyway).

export class RevocationStore {
  private readonly local = new Map<string, number>(); // jti → expires at (ms)

  constructor(
    private readonly ctx: RedisCtx | null,
    private readonly log: (msg: string) => void = (m) => console.warn(m),
  ) {}

  /** Revoke until the token expires. Always remembered locally; Redis failure is logged, not thrown. */
  async revoke(jti: string, ttlSeconds: number): Promise<{ stored: 'redis' | 'local' }> {
    const ttl = Math.max(1, Math.ceil(ttlSeconds));
    this.local.set(jti, Date.now() + ttl * 1000);
    this.sweep();
    if (!this.ctx) return { stored: 'local' };
    try {
      await this.ctx.client.set(key(this.ctx, keys.revoked(jti)), '1', { expiration: { type: 'EX', value: ttl } });
      return { stored: 'redis' };
    } catch (e) {
      this.log(`[revocation] Redis unavailable, revoked locally only: ${(e as Error).message}`);
      return { stored: 'local' };
    }
  }

  /** true = reject the token. Redis down → local knowledge only (fail-open, D-28). */
  async isRevoked(jti: string): Promise<boolean> {
    const exp = this.local.get(jti);
    if (exp !== undefined && exp > Date.now()) return true;
    if (!this.ctx) return false;
    try {
      return (await this.ctx.client.exists(key(this.ctx, keys.revoked(jti)))) === 1;
    } catch (e) {
      this.log(`[revocation] Redis unavailable, fail-open for ${jti}: ${(e as Error).message}`);
      return false;
    }
  }

  private sweep() {
    const now = Date.now();
    for (const [jti, exp] of this.local) if (exp <= now) this.local.delete(jti);
  }
}
