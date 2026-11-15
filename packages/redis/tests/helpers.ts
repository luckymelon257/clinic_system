import { randomBytes } from 'node:crypto';
import { databaseUrl, withDatabase } from '@clinic/db';
import pg from 'pg';
import { connectRedis, deleteByPrefix, disconnectRedis, type RedisCtx } from '../src/client';

export const TEST_PG_URL = process.env.TEST_DATABASE_URL || withDatabase(databaseUrl(), 'clinic_redis_test');
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6380/2';

/** Fresh random prefix per test file: parallel runs and leftovers never collide (CONTRIBUTING.md: tests → DB 2). */
export async function testRedis(): Promise<RedisCtx> {
  return connectRedis({ url: TEST_REDIS_URL, prefix: `t${randomBytes(4).toString('hex')}` });
}

export async function dropRedis(ctx: RedisCtx): Promise<void> {
  await deleteByPrefix(ctx);
  await disconnectRedis(ctx);
}

export const testPool = () => new pg.Pool({ connectionString: TEST_PG_URL, max: 40 });
