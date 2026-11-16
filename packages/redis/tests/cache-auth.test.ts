import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectRedis, disconnectRedis, key, keys, ping, type RedisCtx } from '../src/client';
import { RevocationStore } from '../src/revocation';
import { cachedSlots, getSlots, invalidateSlots, SLOT_TTL_SECONDS, setSlots } from '../src/slots';
import { dropRedis, testRedis } from './helpers';

let ctx: RedisCtx;
beforeAll(async () => {
  ctx = await testRedis();
});
afterAll(() => dropRedis(ctx));

describe('slot cache (F-41, BR-18)', () => {
  const slots = [{ slotStart: '2030-01-01T08:00:00.000Z', slotEnd: '2030-01-01T08:30:00.000Z' }];

  it('set → get hit with TTL 60 s; invalidate → miss', async () => {
    expect(await getSlots(ctx, 1, '2030-01-01')).toBeNull();
    await setSlots(ctx, 1, '2030-01-01', slots);
    expect(await getSlots(ctx, 1, '2030-01-01')).toEqual(slots);
    const ttl = await ctx.client.ttl(key(ctx, keys.slots(1, '2030-01-01')));
    expect(ttl).toBeGreaterThan(SLOT_TTL_SECONDS - 3);
    expect(ttl).toBeLessThanOrEqual(SLOT_TTL_SECONDS);
    await invalidateSlots(ctx, 1, '2030-01-01');
    expect(await getSlots(ctx, 1, '2030-01-01')).toBeNull();
  });

  it('expires by itself', async () => {
    await setSlots(ctx, 2, '2030-01-01', slots, 1);
    await new Promise((r) => setTimeout(r, 1_200));
    expect(await getSlots(ctx, 2, '2030-01-01')).toBeNull();
  });

  it('cache-aside: miss loads from PG once, then hits; Redis absent → PG', async () => {
    let loads = 0;
    const load = async () => {
      loads++;
      return slots;
    };
    expect((await cachedSlots(ctx, 3, '2030-01-01', load)).source).toBe('postgres');
    expect((await cachedSlots(ctx, 3, '2030-01-01', load)).source).toBe('redis');
    expect((await cachedSlots(null, 3, '2030-01-01', load)).source).toBe('postgres');
    expect(loads).toBe(2);
  });
});

describe('JWT revocation (F-42, BR-16, D-27, D-28)', () => {
  it('SET auth:revoked:<jti> 1 EX ttl; revoked until expiry, other tokens unaffected', async () => {
    const store = new RevocationStore(ctx);
    expect(await store.revoke('jti-a', 1)).toEqual({ stored: 'redis' });
    expect(await store.isRevoked('jti-a')).toBe(true);
    expect(await store.isRevoked('jti-b')).toBe(false);
    expect(await ctx.client.get(key(ctx, keys.revoked('jti-a')))).toBe('1');
    // another API process (no local memory) sees it through Redis
    expect(await new RevocationStore(ctx).isRevoked('jti-a')).toBe(true);
    await new Promise((r) => setTimeout(r, 1_200));
    expect(await new RevocationStore(ctx).isRevoked('jti-a')).toBe(false);
  });

  it('Redis down: fails fast, health = down, revocation fail-open except tokens revoked by this process', async () => {
    const down = await connectRedis({ url: 'redis://localhost:6399/0', prefix: 'x' }, { waitForReady: false, onError: () => {} });
    try {
      const h = await ping(down);
      expect(h.status).toBe('down');
      const logs: string[] = [];
      const store = new RevocationStore(down, (m) => logs.push(m));
      const t0 = Date.now();
      expect(await store.isRevoked('someone-else')).toBe(false); // fail-open
      expect(Date.now() - t0).toBeLessThan(500); // no hanging offline queue
      expect(await store.revoke('mine', 60)).toEqual({ stored: 'local' });
      expect(await store.isRevoked('mine')).toBe(true);
      expect(logs.length).toBeGreaterThan(0);
    } finally {
      await disconnectRedis(down);
    }
  });

  it('health ping reports latency when up', async () => {
    const h = await ping(ctx);
    expect(h.status).toBe('up');
    expect(h.latencyMs).not.toBeNull();
  });
});
