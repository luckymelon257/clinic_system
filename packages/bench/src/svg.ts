// Dependency-free static SVG charts for the markdown report. Every chart sits next to a table with the same
// numbers (relief for the two series colours below 3:1 contrast), always has a legend for ≥ 2 series, and every
// mark carries a <title> so hovering in a browser shows the exact value.
// Palette: validated categorical slots 1–4 (dataviz reference palette), assigned in fixed order, never cycled.

export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'] as const;
const SURFACE = '#fcfcfb';
const INK = '#1f1f1d';
const INK_MUTED = '#6b6a63';
const GRID = '#e6e5e0';

export interface Series {
  name: string;
  values: (number | null)[]; // null / non-finite = missing (e.g. timeout) — drawn as a hatched stub
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toPrecision(3) : v.toPrecision(2));
const fmtTick = (v: number) => (v >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : String(Number(v.toPrecision(2))));

function colorOf(i: number): string {
  if (i >= SERIES_COLORS.length) throw new Error(`more than ${SERIES_COLORS.length} series: fold into small multiples`);
  return SERIES_COLORS[i]!;
}

interface Scale {
  y(v: number): number;
  ticks: number[];
}

function scale(values: number[], top: number, bottom: number, logY: boolean): Scale {
  const finite = values.filter((v) => Number.isFinite(v) && (!logY || v > 0));
  const max = finite.length ? Math.max(...finite) : 1;
  if (logY) {
    const lo = Math.floor(Math.log10(Math.min(...finite, max)));
    const hi = Math.max(lo + 1, Math.ceil(Math.log10(max)));
    const ticks = Array.from({ length: hi - lo + 1 }, (_, k) => 10 ** (lo + k));
    return { ticks, y: (v) => bottom - ((Math.log10(Math.max(v, 10 ** lo)) - lo) / (hi - lo)) * (bottom - top) };
  }
  const step = 10 ** Math.floor(Math.log10(max || 1));
  const niceMax = Math.ceil(max / step) * step || 1;
  const ticks = Array.from({ length: 5 }, (_, k) => (niceMax / 4) * k);
  return { ticks, y: (v) => bottom - (v / niceMax) * (bottom - top) };
}

function frame(width: number, height: number, title: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">
<rect width="${width}" height="${height}" fill="${SURFACE}"/>
<text x="16" y="24" font-size="15" font-weight="600" fill="${INK}">${esc(title)}</text>
${body}
</svg>
`;
}

function legend(series: Series[], x: number, y: number): string {
  if (series.length < 2) return '';
  let cx = x;
  return series.map((s, i) => {
    const item = `<rect x="${cx}" y="${y - 9}" width="10" height="10" rx="2" fill="${colorOf(i)}"/><text x="${cx + 14}" y="${y}" font-size="12" fill="${INK}">${esc(s.name)}</text>`;
    cx += 24 + s.name.length * 7;
    return item;
  }).join('\n');
}

function yAxis(sc: Scale, left: number, right: number, yLabel: string, top: number, bottom: number): string {
  const grid = sc.ticks.map((t) => {
    const y = sc.y(t).toFixed(1);
    return `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="${GRID}" stroke-width="1"/><text x="${left - 6}" y="${y}" dy="4" font-size="11" text-anchor="end" fill="${INK_MUTED}">${fmtTick(t)}</text>`;
  }).join('\n');
  const mid = (top + bottom) / 2;
  return `${grid}\n<text transform="translate(14 ${mid}) rotate(-90)" font-size="11" text-anchor="middle" fill="${INK_MUTED}">${esc(yLabel)}</text>`;
}

/** Grouped bars: one group per category, one bar per series. 2 px gap between adjacent bars, 4 px rounded data ends. */
export function barChart(o: { title: string; categories: string[]; series: Series[]; yLabel: string; logY?: boolean }): string {
  const groupW = Math.max(60, o.series.length * 22 + 24);
  const left = 64;
  const width = Math.max(480, left + o.categories.length * groupW + 24);
  const top = 56;
  const bottom = 250;
  const height = bottom + 48;
  const all = o.series.flatMap((s) => s.values).filter((v): v is number => v !== null && Number.isFinite(v));
  const sc = scale(all, top, bottom, !!o.logY);
  const barW = Math.min(20, (groupW - 24) / o.series.length - 2);
  const bars: string[] = [];
  o.categories.forEach((cat, ci) => {
    const gx = left + ci * groupW + 12;
    o.series.forEach((s, si) => {
      const v = s.values[ci];
      const x = gx + si * (barW + 2);
      if (v === null || v === undefined || !Number.isFinite(v)) {
        const what = v === null || v === undefined ? 'no data' : 'timeout';
        bars.push(`<g><title>${esc(`${s.name} · ${cat}: ${what}`)}</title><rect x="${x}" y="${bottom - 6}" width="${barW}" height="6" fill="none" stroke="${colorOf(si)}" stroke-dasharray="2 2"/>` +
          `<text transform="translate(${x + barW / 2 + 3} ${bottom - 10}) rotate(-90)" font-size="10" fill="${INK_MUTED}">${what}</text></g>`);
        return;
      }
      const y = sc.y(v);
      const h = Math.max(1, bottom - y);
      const r = Math.min(4, barW / 2, h);
      // rounded top only: path with arcs at the data end, square at the baseline
      bars.push(`<g><title>${esc(`${s.name} · ${cat}: ${fmt(v)}`)}</title><path d="M${x},${bottom} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${bottom} Z" fill="${colorOf(si)}"/></g>`);
    });
    bars.push(`<text x="${gx + (o.series.length * (barW + 2)) / 2}" y="${bottom + 16}" font-size="11" text-anchor="middle" fill="${INK}">${esc(cat)}</text>`);
  });
  const body = [
    legend(o.series, left, 44),
    yAxis(sc, left, width - 16, o.yLabel + (o.logY ? ' (log)' : ''), top, bottom),
    `<line x1="${left}" x2="${width - 16}" y1="${bottom}" y2="${bottom}" stroke="${INK_MUTED}" stroke-width="1"/>`,
    ...bars,
  ].join('\n');
  return frame(width, height, o.title, body);
}

/** Lines over a numeric x (e.g. concurrency, writes/s): 2 px lines, 8 px markers with a 2 px surface ring. */
export function lineChart(o: { title: string; x: number[]; xLabel: string; series: Series[]; yLabel: string; logY?: boolean }): string {
  const left = 64;
  const width = 560;
  const top = 56;
  const bottom = 250;
  const right = width - 24;
  const height = bottom + 52;
  const all = o.series.flatMap((s) => s.values).filter((v): v is number => v !== null && Number.isFinite(v));
  const sc = scale(all, top, bottom, !!o.logY);
  const xs = o.x.map((_, i) => (o.x.length === 1 ? (left + right) / 2 : left + 16 + (i / (o.x.length - 1)) * (right - left - 32)));
  const lines = o.series.map((s, si) => {
    const pts = s.values.map((v, i) => (v !== null && Number.isFinite(v) ? [xs[i]!, sc.y(v), v] as const : null));
    const segs: string[] = [];
    let d = '';
    pts.forEach((p) => {
      if (!p) {
        if (d) segs.push(d);
        d = '';
        return;
      }
      d += `${d ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)} `;
    });
    if (d) segs.push(d);
    const marks = pts.map((p, i) => (p
      ? `<g><title>${esc(`${s.name} · ${o.xLabel} ${o.x[i]}: ${fmt(p[2])}`)}</title><circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="${colorOf(si)}" stroke="${SURFACE}" stroke-width="2"/></g>`
      : '')).join('');
    return segs.map((sd) => `<path d="${sd}" fill="none" stroke="${colorOf(si)}" stroke-width="2" stroke-linejoin="round"/>`).join('') + marks;
  });
  const xTicks = o.x.map((x, i) => `<text x="${xs[i]!.toFixed(1)}" y="${bottom + 16}" font-size="11" text-anchor="middle" fill="${INK}">${x}</text>`);
  const body = [
    legend(o.series, left, 44),
    yAxis(sc, left, right, o.yLabel + (o.logY ? ' (log)' : ''), top, bottom),
    `<line x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}" stroke="${INK_MUTED}" stroke-width="1"/>`,
    ...xTicks,
    `<text x="${(left + right) / 2}" y="${bottom + 36}" font-size="11" text-anchor="middle" fill="${INK_MUTED}">${esc(o.xLabel)}</text>`,
    ...lines,
  ].join('\n');
  return frame(width, height, o.title, body);
}
