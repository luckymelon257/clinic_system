import { describe, expect, it } from 'vitest';
import { copyValue } from '../../gen/copy';
import { generate } from '../../gen/model';
import { exponential, lognormal, mulberry32, stream, zipf } from '../../gen/prng';
import { daytime, isoDow, ts } from '../../gen/time';

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('PRNG and distributions', () => {
  it('mulberry32 is deterministic and uniform', () => {
    const a = mulberry32(2027);
    const b = mulberry32(2027);
    const xs = Array.from({ length: 100_000 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs.slice(0, 5));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(mean(xs)).toBeCloseTo(0.5, 2);
    expect(mulberry32(2028)()).not.toBe(xs[0]);
  });

  it('section streams are independent of each other', () => {
    expect(stream(2027, 'admissions')()).toBe(stream(2027, 'admissions')());
    expect(stream(2027, 'admissions')()).not.toBe(stream(2027, 'shifts')());
  });

  it('LOS log-normal has median 3.5 and mean 5', () => {
    const r = mulberry32(1);
    const xs = Array.from({ length: 200_000 }, () => lognormal(r, 3.5, 5));
    expect(median(xs)).toBeGreaterThan(3.4);
    expect(median(xs)).toBeLessThan(3.6);
    expect(mean(xs)).toBeGreaterThan(4.85);
    expect(mean(xs)).toBeLessThan(5.15);
  });

  it('exponential mean and zipf head', () => {
    const r = mulberry32(2);
    expect(mean(Array.from({ length: 100_000 }, () => exponential(r, 1.1)))).toBeCloseTo(1.1, 1);
    const z = zipf(600, 0.9);
    const ks = Array.from({ length: 50_000 }, () => z(r));
    expect(Math.min(...ks)).toBe(0);
    expect(Math.max(...ks)).toBeLessThan(600);
    expect(ks.filter((k) => k === 0).length).toBeGreaterThan(ks.filter((k) => k === 99).length * 20);
  });
});

describe('generator helpers', () => {
  it('local time formatting, weekdays and the daytime window', () => {
    expect(ts(0)).toBe('2025-11-01 00:00');
    expect(ts(1440 + 8 * 60 + 5)).toBe('2025-11-02 08:05');
    expect(ts(-1440)).toBe('2025-10-31 00:00');
    expect(isoDow(0)).toBe(6); // 2025-11-01 is a Saturday
    expect(daytime(3 * 60)).toBe(8 * 60);
    expect(daytime(23 * 60)).toBe(1440 + 8 * 60);
    expect(daytime(12 * 60)).toBe(12 * 60);
  });

  it('COPY text escaping', () => {
    expect(copyValue(null)).toBe('\\N');
    expect(copyValue('a\tb\\c\nd')).toBe('a\\tb\\\\c\\nd');
    expect(copyValue(5)).toBe('5');
  });

  it('×1 is deterministic and matches the scenario', () => {
    const a = generate(1);
    const b = generate(1);
    expect(a.seed).toBe(2027);
    expect(a.facts).toEqual(b.facts);
    const rows = (ds: typeof a, name: string) => [...ds.tables.find((t) => t.name === name)!.rows()];
    expect(rows(a, 'admissions').slice(0, 50)).toEqual(rows(b, 'admissions').slice(0, 50));
    expect(rows(a, 'beds')).toHaveLength(400);
    expect(rows(a, 'staff')).toHaveLength(360);
    expect(a.facts.admissionsPerDay).toBeGreaterThan(60);
    expect(a.facts.admissionsPerDay).toBeLessThan(68);
    expect(a.facts.occupancy).toBeGreaterThan(0.77);
    expect(a.facts.occupancy).toBeLessThan(0.84);
    expect(a.facts.appointments).toBeGreaterThan(140_000);
    expect(a.facts.appointments).toBeLessThan(160_000);
  });
});
