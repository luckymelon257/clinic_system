import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { loadResults } from './bench';
import { renderReport } from './report';

// pnpm bench:report [results/a.json …] → report/<name>/README.md + charts/*.svg (default: every results/*.json
// except --quick smoke runs).

const files = process.argv.slice(2).filter((a) => a.endsWith('.json'));
const inputs = files.length
  ? files
  : readdirSync('results').filter((f) => f.endsWith('.json') && !f.includes('-quick') && !f.includes('.tmp.')).sort().map((f) => join('results', f));
if (inputs.length === 0) {
  console.error('no results/*.json yet — run `pnpm bench` first');
  process.exit(1);
}
for (const file of inputs) {
  const dir = join('report', basename(file, '.json'));
  const { markdown, files: assets } = renderReport(loadResults(file));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), markdown);
  for (const [rel, svg] of Object.entries(assets)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), svg);
  }
  console.log(`${file} → ${dir}/README.md (+${Object.keys(assets).length} charts)`);
}
