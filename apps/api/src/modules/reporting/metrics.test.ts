import { describe, expect, it } from 'vitest';
import { percentile, rate, stats } from './metrics';

describe('report metrics (TC-RPT-001 unit part)', () => {
  it('percentiles interpolate like percentile_cont', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1);
    expect(percentile([], 0.5)).toBeNull();
  });
  it('stats are in minutes; rates guard against division by zero', () => {
    expect(stats([5, 10, 15].map((m) => m * 60_000))).toEqual({ count: 3, medianMin: 10, p90Min: 14, maxMin: 15 });
    expect(rate(1, 4)).toBe(0.25);
    expect(rate(0, 0)).toBeNull();
  });
});
