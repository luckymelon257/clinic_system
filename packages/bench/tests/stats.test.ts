import { describe, expect, it } from 'vitest';
import { fmtMs, median, quantile, summarize } from '../src/stats';

describe('stats', () => {
  it('nearest-rank quantiles return observed values', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(quantile(xs, 0.5)).toBe(50);
    expect(quantile(xs, 0.95)).toBe(95);
    expect(quantile(xs, 0.99)).toBe(99);
    expect(quantile(xs, 1)).toBe(100);
    expect(quantile([7], 0.99)).toBe(7);
  });

  it('timeouts are +Infinity and surface in the high quantiles only', () => {
    const s = summarize(Array.from({ length: 98 }, () => 10), 2);
    expect(s.n).toBe(100);
    expect(s.p50).toBe(10);
    expect(s.p95).toBe(10);
    expect(s.p99).toBe(Infinity);
    expect(s.max).toBe(Infinity);
    expect(s.mean).toBe(10); // mean over successful operations
    expect(fmtMs(s.p99)).toBe('timeout');
  });

  it('median of repetitions', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
