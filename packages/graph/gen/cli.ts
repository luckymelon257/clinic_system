import { parseArgs } from 'node:util';
import { databaseUrl, withDatabase } from '@clinic/db';
import { loadDataset } from './load';
import { generate } from './model';

// pnpm --filter @clinic/graph gen -- --scale 1|5|10  →  drops and rebuilds clinic_bench_x{N}

const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== '--'), options: { scale: { type: 'string', default: '1' }, url: { type: 'string' } } });
const scale = Number(values.scale);
if (![1, 5, 10].includes(scale)) throw new Error('--scale must be 1, 5 or 10');
const url = values.url ?? withDatabase(databaseUrl(), `clinic_bench_x${scale}`);

const t0 = Date.now();
const ds = generate(scale);
console.log(`[x${scale}] seed ${ds.seed}: generated in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  admissions/day ${ds.facts.admissionsPerDay!.toFixed(1)} per hospital, occupancy ${(ds.facts.occupancy! * 100).toFixed(1)} %, open stays ${ds.facts.openStays}`);
const r = await loadDataset(url, ds);
const total = r.tables.reduce((s, t) => s + t.rows, 0);
console.log(`\n[${r.database}] ${total.toLocaleString('en-US')} rows, ${r.size}, ${r.seconds.toFixed(0)}s total`);
console.log('| table | rows |\n|---|---:|');
for (const t of r.tables) console.log(`| ${t.table} | ${t.rows.toLocaleString('en-US')} |`);
console.log('\n| graph (v_graph_counts) | count |\n|---|---:|');
for (const g of r.graphCounts) console.log(`| ${g.kind} ${g.label} | ${g.count.toLocaleString('en-US')} |`);
