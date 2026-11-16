import { execFileSync } from 'node:child_process';
import os from 'node:os';
import type { Engines } from './engines';
import type { Engine } from './types';

// Everything needed to reproduce / judge a run goes into the results file: client machine, container limits,
// engine versions and the settings that matter for the comparison. No host names or user names are recorded.

const PG_SETTINGS = [
  'server_version', 'shared_buffers', 'effective_cache_size', 'work_mem', 'maintenance_work_mem', 'random_page_cost',
  'jit', 'max_parallel_workers_per_gather', 'max_connections', 'statement_timeout', 'TimeZone',
];

const NEO4J_SETTINGS = [
  'server.memory.heap.initial_size', 'server.memory.heap.max_size', 'server.memory.pagecache.size',
  'db.transaction.timeout', 'server.cypher.parallel.worker_limit', 'dbms.cypher.planner',
];

const REDIS_CONFIG = ['maxmemory', 'maxmemory-policy', 'appendonly', 'appendfsync', 'save', 'io-threads'];

function sh(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
  } catch {
    return null;
  }
}

/** CPU / memory limits of the compose containers (`docker inspect`), or null when Docker is not used. */
export function containerLimits(): Record<string, unknown> | null {
  const out = sh('docker', ['inspect', '--format', '{{.Name}} {{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.Config.Image}}',
    'clinic-db', 'clinic-neo4j', 'clinic-redis']);
  if (!out) return null;
  return Object.fromEntries(out.split('\n').map((line) => {
    const [name, nano, mem, image] = line.split(' ');
    return [name!.replace(/^\//, ''), { cpus: Number(nano) / 1e9 || null, memoryBytes: Number(mem) || null, image }];
  }));
}

export function gitInfo(): { commit: string | null; dirty: boolean | null } {
  const commit = sh('git', ['rev-parse', 'HEAD']);
  const status = sh('git', ['status', '--porcelain']);
  return { commit, dirty: status === null ? null : status.length > 0 };
}

export async function captureEnvironment(engines: Engines, used: ReadonlySet<Engine>): Promise<Record<string, unknown>> {
  const env: Record<string, unknown> = {
    client: {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      cpuModel: os.cpus()[0]?.model ?? null,
      cpuCount: os.cpus().length,
      totalMemBytes: os.totalmem(),
    },
    containers: containerLimits() ?? { note: process.env.BENCH_LIMITS_NOTE || 'docker not available; engines run without container limits' },
  };
  if (used.has('postgres')) {
    const { rows } = await engines.pg.query<{ name: string; setting: string; unit: string | null }>(
      'SELECT name, setting, unit FROM pg_settings WHERE name = ANY ($1)', [PG_SETTINGS]);
    const { rows: v } = await engines.pg.query<{ version: string; db: string; size: string }>(
      'SELECT version(), current_database() AS db, pg_size_pretty(pg_database_size(current_database())) AS size');
    env.postgres = {
      version: v[0]?.version,
      database: v[0]?.db,
      databaseSize: v[0]?.size,
      settings: Object.fromEntries(rows.map((r) => [r.name, r.unit ? `${r.setting} ${r.unit}` : r.setting])),
    };
  }
  if (used.has('neo4j')) {
    const comp = await engines.cypher('CALL dbms.components() YIELD name, versions, edition RETURN name, versions, edition');
    const settings = await engines.cypher('SHOW SETTINGS YIELD name, value WHERE name IN $names RETURN name, value', { names: NEO4J_SETTINGS });
    const counts = await engines.cypher('MATCH (n) RETURN count(n) AS nodes').then(async (n) => ({
      nodes: (n[0] as { nodes: number }).nodes,
      rels: ((await engines.cypher('MATCH ()-[r]->() RETURN count(r) AS rels'))[0] as { rels: number }).rels,
    }));
    env.neo4j = {
      components: comp,
      settings: Object.fromEntries((settings as { name: string; value: string }[]).map((s) => [s.name, s.value])),
      counts,
    };
  }
  if (used.has('redis')) {
    const r = await engines.redis();
    const info = await r.info('server');
    const config: Record<string, string> = {};
    for (const k of REDIS_CONFIG) Object.assign(config, await r.configGet(k));
    env.redis = { version: /redis_version:(\S+)/.exec(info)?.[1] ?? null, config };
  }
  return env;
}
