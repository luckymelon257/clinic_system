import { resetDatabase } from '@clinic/db';
import { createDriver, fullEtl } from '@clinic/graph';
import { TEST_NEO4J, TEST_URL } from './url';

export default async function setup() {
  await resetDatabase(TEST_URL, { volume: false });
  // Neo4j test instance (bolt 7689) = full ETL of the freshly seeded test database (D-23 bootstrap)
  const driver = createDriver(TEST_NEO4J);
  try {
    await fullEtl(TEST_URL, driver);
  } finally {
    await driver.close();
  }
}
