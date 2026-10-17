import { databaseUrl, withDatabase } from '@clinic/db';

export const TEST_URL = process.env.TEST_DATABASE_URL || withDatabase(databaseUrl(), 'clinic_api_test');
