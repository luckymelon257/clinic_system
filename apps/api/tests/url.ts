import { databaseUrl, withDatabase } from '@clinic/db';

export const TEST_URL = process.env.TEST_DATABASE_URL || withDatabase(databaseUrl(), 'clinic_api_test');

// AGENTS.md: W2 api uses the neo4j-test instance and Redis DB 4 with a random prefix in tests
export const TEST_NEO4J = {
  url: process.env.TEST_NEO4J_URL || 'bolt://localhost:7689',
  user: process.env.NEO4J_USER || 'neo4j',
  password: process.env.NEO4J_PASSWORD || 'clinicneo4j',
};
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6380/4';
