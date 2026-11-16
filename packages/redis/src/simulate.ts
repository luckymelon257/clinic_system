import { parseArgs } from 'node:util';
import { databaseUrl } from '@clinic/db';
import pg from 'pg';
import { connectRedis, disconnectRedis, redisConfigFromEnv } from './client';
import { ingestVitals, type VitalsReading } from './icu';

// ICU bedside-monitor simulator (F-44): every ICU bed from v_icu_beds sends `rate` readings per second.
// Values random-walk around a healthy baseline; now and then a bed enters a 10–30 s critical episode in one sign
// (bradycardia, desaturation, hypotension, …) so the monitor page shows real alerts.
//   pnpm simulate [--beds 6] [--rate 1] [--duration 0 (forever)] [--episode 0.01]

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'), // `pnpm simulate -- --beds 2` forwards a literal '--'
  options: {
    beds: { type: 'string' },
    rate: { type: 'string', default: '1' },
    duration: { type: 'string', default: '0' },
    episode: { type: 'string', default: '0.01' }, // probability per reading that a critical episode starts
    seed: { type: 'string', default: '2026' },
  },
});

// mulberry32 — deterministic noise, the same run every time for a given seed
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(Number(values.seed));
const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());

type Sign = 'hr' | 'spo2' | 'sbp' | 'dbp' | 'rr' | 'temp';
const BASE: Record<Sign, number> = { hr: 82, spo2: 96.5, sbp: 122, dbp: 76, rr: 16, temp: 36.9 };
const NOISE: Record<Sign, number> = { hr: 1.5, spo2: 0.3, sbp: 1.5, dbp: 1, rr: 0.4, temp: 0.03 };
const EPISODES: { sign: Sign; target: number }[] = [
  { sign: 'hr', target: 34 }, { sign: 'hr', target: 155 }, { sign: 'spo2', target: 82 }, { sign: 'sbp', target: 72 },
  { sign: 'sbp', target: 215 }, { sign: 'rr', target: 36 }, { sign: 'temp', target: 40.2 },
];

interface BedState {
  bedId: number;
  patientId: number | null;
  v: Record<Sign, number>;
  episode: { sign: Sign; target: number; left: number } | null;
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

function step(b: BedState, episodeP: number, rate: number): VitalsReading {
  if (!b.episode && rand() < episodeP) {
    const e = EPISODES[Math.floor(rand() * EPISODES.length)]!;
    b.episode = { ...e, left: Math.round((10 + rand() * 20) * rate) };
  }
  for (const s of Object.keys(BASE) as Sign[]) {
    const target = b.episode?.sign === s ? b.episode.target : BASE[s];
    b.v[s] += (target - b.v[s]) * (b.episode?.sign === s ? 0.25 : 0.1) + gauss() * NOISE[s];
  }
  if (b.episode && --b.episode.left <= 0) b.episode = null;
  return {
    bedId: b.bedId, patientId: b.patientId, atMs: Date.now(),
    hr: round(b.v.hr, 0), spo2: round(Math.min(100, b.v.spo2), 1), sbp: round(b.v.sbp, 0), dbp: round(b.v.dbp, 0),
    rr: round(b.v.rr, 0), temp: round(b.v.temp, 1),
  };
}

const db = new pg.Pool({ connectionString: databaseUrl(), max: 2 });
const { rows } = await db.query<{ bed_id: number; patient_id: number | null; ward_number: string; bed_number: string }>(
  'SELECT bed_id, patient_id, ward_number, bed_number FROM v_icu_beds ORDER BY bed_id');
await db.end();
const limit = values.beds ? Number(values.beds) : rows.length;
const beds: BedState[] = rows.slice(0, limit).map((r) => ({ bedId: r.bed_id, patientId: r.patient_id, v: { ...BASE }, episode: null }));
if (!beds.length) {
  console.error('no ICU beds in v_icu_beds');
  process.exit(1);
}

const rate = Number(values.rate);
const episodeP = Number(values.episode);
const durationMs = Number(values.duration) * 1000;
const cfg = redisConfigFromEnv();
const ctx = await connectRedis(cfg);
console.log(`[simulate] ${beds.length} ICU beds × ${rate}/s → ${cfg.url} prefix '${cfg.prefix}'${durationMs ? ` for ${values.duration}s` : ''}`);

let sent = 0;
let alerts = 0;
const started = Date.now();
const timer = setInterval(async () => {
  const results = await Promise.allSettled(beds.map((b) => ingestVitals(ctx, step(b, episodeP, rate))));
  for (const r of results) {
    if (r.status === 'fulfilled') {
      sent++;
      if (r.value.alert) {
        alerts++;
        const a = r.value.alert;
        console.log(`[alert] bed ${a.bedId}: ${a.violations.map((v) => `${v.sign} ${v.value} (${v.rule})`).join(', ')}`);
      }
    } else console.warn(`[simulate] ${(r.reason as Error).message}`);
  }
}, 1000 / rate);

const stop = async () => {
  clearInterval(timer);
  await disconnectRedis(ctx);
  console.log(`[simulate] ${sent} readings, ${alerts} alerts in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (durationMs) setTimeout(stop, durationMs);
