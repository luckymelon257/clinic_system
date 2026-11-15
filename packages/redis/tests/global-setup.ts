import { resetDatabase } from '@clinic/db';
import { TEST_PG_URL } from './helpers';

export default async function setup() {
  await resetDatabase(TEST_PG_URL, { volume: false });
}
