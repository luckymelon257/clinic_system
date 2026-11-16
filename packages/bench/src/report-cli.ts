import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { loadResults, mergeResults } from './bench';
import { renderReport } from './report';

// pnpm bench:report [results/a.json …] → report/<name>/README.md + charts/*.svg (default: every results/*.json
// except --quick smoke runs and unfinished *.tmp.json). Step files `<group>__<step>.json` of a resumable run are
// merged into one report per group.

const files = process.argv.slice(2).filter((a) => a.endsWith('.json'));
const inputs = files.length
  ? files
  : readdirSync('results').filter((f) => f.endsWith('.json') && !f.includes('-quick') && !f.endsWith('.tmp')).sort().map((f) => join('results', f));
if (inputs.length === 0) {
  console.error('no results/*.json yet — run `pnpm bench` first');
  process.exit(1);
}
const groups = new Map<string, string[]>();
for (const file of inputs) {
  const name = basename(file, '.json').split('__')[0]!;
  groups.set(name, [...(groups.get(name) ?? []), file]);
}
for (const [name, group] of groups) {
  const dir = join('report', name);
  const { markdown, files: assets } = renderReport(mergeResults(group.sort().map(loadResults)));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), markdown);
  for (const [rel, svg] of Object.entries(assets)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), svg);
  }
  console.log(`${group.length} file(s) → ${dir}/README.md (+${Object.keys(assets).length} charts)`);
}
