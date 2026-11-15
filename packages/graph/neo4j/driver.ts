import neo4j, { type Driver } from 'neo4j-driver';

/** Open interval end in the graph (PG 'infinity'), see fn_epoch_ms in migration 009. */
export const OPEN_END = 9e15;

export interface Neo4jConfig {
  url: string;
  user: string;
  password: string;
}

export function neo4jConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Neo4jConfig {
  return {
    url: env.NEO4J_URL || 'bolt://localhost:7688',
    user: env.NEO4J_USER || 'neo4j',
    password: env.NEO4J_PASSWORD || 'clinicneo4j',
  };
}

/** Integers come back as JS numbers: ids and epoch ms stay below 2^53. */
export function createDriver(cfg: Neo4jConfig = neo4jConfigFromEnv(), poolSize = 50): Driver {
  return neo4j.driver(cfg.url, neo4j.auth.basic(cfg.user, cfg.password), {
    disableLosslessIntegers: true,
    maxConnectionPoolSize: poolSize,
  });
}

/** Run a read query in a managed transaction and return plain objects (all records consumed). */
export async function readRows<T = Record<string, unknown>>(
  driver: Driver,
  query: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<T[]> {
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const res = await session.executeRead((tx) => tx.run(query, params), timeoutMs ? { timeout: timeoutMs } : undefined);
    return res.records.map((r) => r.toObject() as T);
  } finally {
    await session.close();
  }
}
