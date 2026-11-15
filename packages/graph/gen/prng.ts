// Deterministic randomness for the bench data generator: mulberry32 (32-bit state, period 2^32), seed 2026 + scale.
// Every section of the generator gets its own stream (`stream(seed, 'admissions')`), so the data of one table
// does not depend on how many numbers another table consumed — the dataset is reproducible bit for bit.

export type Rng = () => number; // uniform [0, 1)

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a of the section name mixed into the seed → an independent stream per section. */
export function stream(seed: number, section: string): Rng {
  let h = 0x811c9dc5;
  for (let i = 0; i < section.length; i++) h = Math.imul(h ^ section.charCodeAt(i), 0x01000193);
  return mulberry32((seed ^ h) >>> 0);
}

/** Integer in [lo, hi] inclusive. */
export const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
export const chance = (r: Rng, p: number) => r() < p;

/** Standard normal via Box–Muller. */
export function normal(r: Rng): number {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/**
 * Log-normal with the given median and mean: μ = ln(median), σ² = 2·ln(mean / median).
 * LOS: median 3.5 d, mean 5 d → σ ≈ 0.845.
 */
export function lognormal(r: Rng, median: number, mean: number): number {
  const mu = Math.log(median);
  const sigma = Math.sqrt(2 * Math.log(mean / median));
  return Math.exp(mu + sigma * normal(r));
}

export const exponential = (r: Rng, mean: number) => -mean * Math.log(1 - r());

export function shuffle<T>(r: Rng, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}

/** Zipf(s) over 0..n-1 (rank 0 most popular) — drug popularity is heavy-tailed. */
export function zipf(n: number, s: number): (r: Rng) => number {
  const cdf = new Float64Array(n);
  let acc = 0;
  for (let k = 0; k < n; k++) cdf[k] = acc += 1 / (k + 1) ** s;
  for (let k = 0; k < n; k++) cdf[k]! /= acc;
  return (r) => {
    const u = r();
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid]! < u) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}
