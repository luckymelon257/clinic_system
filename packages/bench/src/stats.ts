// Latency statistics. Quantiles use the nearest-rank method (no interpolation): every reported value is a
// latency that actually happened. Timeouts count as +Infinity, so a quantile that lands on one reads "timeout".

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (q <= 0) return sorted[0]!;
  const rank = Math.ceil(q * sorted.length); // 1-based nearest rank
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export interface Summary {
  n: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** `latencies` in ms; `timeouts` are appended as +Infinity. Mean is over successful operations only. */
export function summarize(latencies: readonly number[], timeouts = 0): Summary {
  const all = [...latencies, ...Array<number>(timeouts).fill(Infinity)].sort((a, b) => a - b);
  const mean = latencies.length ? latencies.reduce((s, x) => s + x, 0) / latencies.length : NaN;
  return {
    n: all.length,
    min: all.length ? all[0]! : NaN,
    mean,
    p50: quantile(all, 0.5),
    p95: quantile(all, 0.95),
    p99: quantile(all, 0.99),
    max: all.length ? all[all.length - 1]! : NaN,
  };
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Human formatting for tables: ms with 3 significant digits, ∞ → 'timeout'. */
export function fmtMs(x: number | null | undefined): string {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  if (!Number.isFinite(x)) return 'timeout';
  if (x >= 100) return x.toFixed(0);
  if (x >= 10) return x.toFixed(1);
  if (x >= 1) return x.toFixed(2);
  return x.toFixed(3);
}

export function fmtNum(x: number | null | undefined, digits = 0): string {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  if (!Number.isFinite(x)) return '∞';
  return x.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
