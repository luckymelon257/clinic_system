import { randomBytes } from 'node:crypto';
import { TEST_NEO4J, TEST_REDIS_URL, TEST_URL } from './url';

process.env.DATABASE_URL = TEST_URL;
process.env.JWT_SECRET = 'test-secret';
process.env.NEO4J_URL = TEST_NEO4J.url;
process.env.NEO4J_USER = TEST_NEO4J.user;
process.env.NEO4J_PASSWORD = TEST_NEO4J.password;
process.env.REDIS_URL = TEST_REDIS_URL;
process.env.REDIS_PREFIX = `apitest-${randomBytes(4).toString('hex')}`; // per test file: no shared keys or channels
