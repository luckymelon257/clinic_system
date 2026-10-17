import { databaseUrl, withDatabase } from '../src/index';

export const TEST_URL = process.env.TEST_DATABASE_URL || withDatabase(databaseUrl(), 'clinic_db_test');
