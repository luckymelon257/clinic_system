import { databaseUrl, migrate, resetDatabase, seed } from './index';

const [cmd, ...flags] = process.argv.slice(2);
const url = databaseUrl();
const db = new URL(url).pathname.slice(1);
const started = Date.now();

switch (cmd) {
  case 'migrate': {
    const applied = await migrate(url);
    console.log(`[${db}] migrations applied: ${applied.length ? applied.join(', ') : 'none (up to date)'}`);
    break;
  }
  case 'seed': {
    const ran = await seed(url, { volume: flags.includes('--volume') });
    console.log(`[${db}] seeds: ${ran.join(', ')}`);
    break;
  }
  case 'reset': {
    const volume = !flags.includes('--no-volume');
    await resetDatabase(url, { volume });
    console.log(`[${db}] reset done (volume=${volume})`);
    break;
  }
  default:
    console.error('usage: cli.ts migrate | seed [--volume] | reset [--no-volume]');
    process.exit(1);
}
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
