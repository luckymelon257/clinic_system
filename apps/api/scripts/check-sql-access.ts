/**
 * AGENTS.md rule 2: apps/api/src reads only v_* / mv_* / fn_* and writes only via CALL sp_*.
 * Scans every string / template literal in src/**\/*.ts (comments are skipped) and fails on direct table access.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** String and template literal bodies of a TS source, comments skipped. */
export function stringLiterals(src: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') i = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
    else if (c === '/' && src[i + 1] === '*') i = src.indexOf('*/', i + 2) + 1 || src.length;
    else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out.push(src.slice(i + 1, j));
      i = j;
    }
  }
  return out;
}

const RULES: [RegExp, (m: RegExpExecArray) => boolean][] = [
  [/\bINSERT\s+INTO\b/gi, () => true],
  [/\bDELETE\s+FROM\b/gi, () => true],
  [/\bUPDATE\s+\S+\s+SET\b/gi, () => true],
  // the relation after FROM / JOIN must be a view or a function; `${…}` cannot be verified, so it fails too
  [/\b(?:FROM|JOIN)\s+([^\s(),;]+)/gi, (m) => !/^"?(v|mv|fn)_\w+"?$/i.test(m[1]!)],
];

export function violations(src: string): string[] {
  const found: string[] = [];
  for (const lit of stringLiterals(src))
    for (const [re, bad] of RULES) for (const m of lit.matchAll(re)) if (bad(m)) found.push(m[0]);
  return found;
}

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : [],
  );

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const srcDir = fileURLToPath(new URL('../src', import.meta.url));
  let bad = 0;
  const all = files(srcDir);
  for (const f of all)
    for (const v of violations(readFileSync(f, 'utf8'))) {
      bad++;
      console.error(`${f.slice(srcDir.length - 3)}: forbidden SQL "${v}"`);
    }
  if (bad) {
    console.error(`check:sql-access FAILED — ${bad} violation(s). Use v_* / mv_* / fn_* for reads and CALL sp_* for writes.`);
    process.exit(1);
  }
  console.log(`check:sql-access OK — ${all.length} files, only v_* / mv_* / fn_* reads and CALL sp_* writes.`);
}
