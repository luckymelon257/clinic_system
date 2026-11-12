import { fmtMs, fmtNum, median } from './stats';
import { barChart, lineChart } from './svg';
import type { BenchResults, CustomTable, RunStats, ScenarioResult, VariantResult } from './types';

// Results JSON → markdown + SVG files. Every number in a table is the MEDIAN over repetitions of that run's
// statistic; the p50 spread (min–max over repetitions) shows how stable the measurement was.

export interface RenderedReport {
  markdown: string;
  files: Record<string, string>; // relative path → SVG content
}

interface Agg {
  label: string;
  concurrency: number;
  reps: number;
  n: number;
  timeouts: number;
  p50: number;
  p50min: number;
  p50max: number;
  p95: number;
  p99: number;
  max: number;
  throughput: number;
}

export function aggregate(runs: readonly RunStats[]): Agg[] {
  const groups = new Map<string, RunStats[]>();
  for (const r of runs) {
    const k = `${r.label}\u0000${r.concurrency}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map((g) => {
    const p50s = g.map((r) => r.p50);
    return {
      label: g[0]!.label,
      concurrency: g[0]!.concurrency,
      reps: g.length,
      n: g.reduce((s, r) => s + r.n, 0),
      timeouts: g.reduce((s, r) => s + r.timeouts, 0),
      p50: median(p50s),
      p50min: Math.min(...p50s),
      p50max: Math.max(...p50s),
      p95: median(g.map((r) => r.p95)),
      p99: median(g.map((r) => r.p99)),
      max: Math.max(...g.map((r) => r.max)),
      throughput: median(g.map((r) => r.throughput)),
    };
  });
}

/** Op labels in order of first appearance — fixed colour slot per op for the whole scenario. */
function labelsOf(sc: ScenarioResult): string[] {
  const seen: string[] = [];
  for (const v of sc.variants) for (const r of v.runs) if (!seen.includes(r.label)) seen.push(r.label);
  return seen;
}

const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

function variantTable(v: VariantResult): string {
  const rows = aggregate(v.runs)
    .sort((a, b) => a.concurrency - b.concurrency)
    .map((a) => [
      String(a.concurrency), a.label, fmtMs(a.p50), `${fmtMs(a.p50min)}–${fmtMs(a.p50max)}`, fmtMs(a.p95), fmtMs(a.p99),
      fmtMs(a.max), fmtNum(a.throughput, 1), String(a.n), a.timeouts ? `**${a.timeouts}**` : '0',
    ]);
  return table(['c', 'engine', 'p50, ms', 'p50 spread', 'p95, ms', 'p99, ms', 'max, ms', 'ops/s', 'n', 'timeouts'], rows);
}

/** p50 ratio of every op to the LAST op label (scenarios list the NoSQL op last → e.g. postgres / neo4j). */
function ratioLine(v: VariantResult, labels: string[]): string {
  if (labels.length < 2) return '';
  const aggs = aggregate(v.runs);
  const base = labels[labels.length - 1]!;
  const parts: string[] = [];
  for (const c of [...new Set(aggs.map((a) => a.concurrency))].sort((a, b) => a - b)) {
    const b = aggs.find((a) => a.label === base && a.concurrency === c);
    for (const l of labels.slice(0, -1)) {
      const a = aggs.find((x) => x.label === l && x.concurrency === c);
      if (a && b && Number.isFinite(a.p50) && Number.isFinite(b.p50) && b.p50 > 0) parts.push(`c=${c}: ${l} / ${base} = ${(a.p50 / b.p50).toFixed(2)}×`);
    }
  }
  return parts.length ? `p50 ratio — ${parts.join('; ')}` : '';
}

function customTable(t: CustomTable): string {
  return `**${t.title}**\n\n` + table(t.columns, t.rows.map((r) => r.map((c) => (c === null ? '—' : typeof c === 'number' ? fmtNum(c, Number.isInteger(c) ? 0 : 2) : c))));
}

function scenarioSection(sc: ScenarioResult, files: Record<string, string>, dir: string): string {
  const out: string[] = [`## ${sc.id} — ${sc.title}`, '', `- **Чому:** ${sc.why}`, `- **Очікування:** ${sc.expect}`, `- **Спростовано, якщо:** ${sc.falsifiedIf}`];
  const m = sc.measure;
  out.push(`- Методика: прогрів ${m.warmupIterations} ітерацій / ${m.warmupMs / 1000} с; вимір ${m.minIterations} ітерацій / ${m.maxMs / 1000} с (мінімум ${m.minSamples}); ${m.repetitions} повтори з чергуванням рушіїв; таймаут ${m.timeoutMs / 1000} с.`, '');
  if (sc.error) out.push(`> **Сценарій не виконано:** ${sc.error}`, '');

  const labels = labelsOf(sc);
  if (sc.variants.length) {
    // Chart 1: p50 at the lowest concurrency, one group per variant
    const c0 = Math.min(...sc.variants.flatMap((v) => v.runs.map((r) => r.concurrency)));
    const p50 = barChart({
      title: `${sc.id}: p50 latency, concurrency ${c0}`,
      categories: sc.variants.map((v) => v.label),
      series: labels.map((l) => ({ name: l, values: sc.variants.map((v) => aggregate(v.runs).find((a) => a.label === l && a.concurrency === c0)?.p50 ?? null) })),
      yLabel: 'ms',
      logY: true,
    });
    files[`${dir}/${sc.id}-p50.svg`] = p50;
    out.push(`![${sc.id} p50](${dir}/${sc.id}-p50.svg)`, '');
    // Chart 2: throughput vs concurrency for the last (largest) variant
    const last = sc.variants[sc.variants.length - 1]!;
    const cs = [...new Set(last.runs.map((r) => r.concurrency))].sort((a, b) => a - b);
    if (cs.length > 1) {
      files[`${dir}/${sc.id}-throughput.svg`] = lineChart({
        title: `${sc.id}: throughput vs concurrency (${last.label})`,
        x: cs,
        xLabel: 'concurrent clients',
        series: labels.map((l) => ({ name: l, values: cs.map((c) => aggregate(last.runs).find((a) => a.label === l && a.concurrency === c)?.throughput ?? null) })),
        yLabel: 'ops/s',
      });
      out.push(`![${sc.id} throughput](${dir}/${sc.id}-throughput.svg)`, '');
    }
    for (const v of sc.variants) {
      out.push(`### ${sc.id} · ${v.label}`, '', `Параметри: \`${JSON.stringify(v.params)}\``, '', variantTable(v), '');
      const ratio = ratioLine(v, labels);
      if (ratio) out.push(ratio, '');
      for (const [label, plan] of Object.entries(v.explain)) {
        out.push(`<details><summary>План: ${label}</summary>`, '', '```', plan.trimEnd(), '```', '', '</details>', '');
      }
    }
  }
  sc.tables.forEach((t, i) => {
    out.push(customTable(t), '');
    if (t.chart) {
      const xi = t.columns.indexOf(t.chart.x);
      const name = `${dir}/${sc.id}-t${i + 1}.svg`;
      files[name] = lineChart({
        title: `${sc.id}: ${t.title}`,
        x: t.rows.map((r) => Number(r[xi])),
        xLabel: t.chart.x,
        series: t.chart.y.map((col) => ({ name: col, values: t.rows.map((r) => { const v = r[t.columns.indexOf(col)]; return typeof v === 'number' ? v : null; }) })),
        yLabel: t.chart.yLabel,
        logY: t.chart.logY,
      });
      out.push(`![${sc.id} ${t.title}](${name})`, '');
    }
  });
  return out.join('\n');
}

export function renderReport(r: BenchResults, assetDir = 'charts'): RenderedReport {
  const files: Record<string, string> = {};
  const head = [
    `# Benchmark ${r.runId} (${r.scale})`,
    '',
    `- Запуск: ${r.startedAt} → ${r.finishedAt}`,
    `- Коміт: \`${r.git.commit ?? 'n/a'}\`${r.git.dirty ? ' (є незакомічені зміни)' : ''}`,
    `- Параметри: \`${r.paramsFile ?? '—'}\`, SHA-256 \`${r.paramsSha256}\``,
    '',
    '<details><summary>Середовище (клієнт, ліміти контейнерів, налаштування рушіїв)</summary>',
    '',
    '```json',
    JSON.stringify(r.environment, null, 2),
    '```',
    '',
    '</details>',
    '',
  ];
  const body = r.scenarios.map((s) => scenarioSection(s, files, assetDir));
  return { markdown: [...head, ...body].join('\n') + '\n', files };
}
