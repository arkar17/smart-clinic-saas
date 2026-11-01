/** Linear-interpolated percentile (same as PostgreSQL percentile_cont); null for an empty sample. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return v[lo]! + (v[hi]! - v[lo]!) * (idx - lo);
}

export interface DurationStats { count: number; medianMin: number | null; p90Min: number | null; maxMin: number | null }
/** Minutes, rounded to 0.1 min. */
export function stats(ms: number[]): DurationStats {
  const r = (x: number | null) => (x === null ? null : Math.round((x / 60_000) * 10) / 10);
  return { count: ms.length, medianMin: r(percentile(ms, 0.5)), p90Min: r(percentile(ms, 0.9)), maxMin: r(ms.length ? Math.max(...ms) : null) };
}

export const rate = (num: number, den: number) => (den === 0 ? null : Math.round((num / den) * 1000) / 1000);
