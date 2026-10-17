import { resetDatabase } from '@clinic/db';
import { TEST_URL } from './url';

export default async function setup() {
  await resetDatabase(TEST_URL, { volume: false });
}
