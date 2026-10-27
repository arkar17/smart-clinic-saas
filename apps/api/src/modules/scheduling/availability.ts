// Pure availability-interval engine (SRS §12, Arch §16). No I/O: callers load rows once and pass them in.
import { isoWeekday, localMinutesToUtc } from '../../infra/time';

export interface Interval { start: number; end: number } // local minutes [start, end)
export interface WeeklyRow { weekday: number; startMin: number; endMin: number }
export interface ClosureRow { startDate: string; endDate: string; startMin: number | null; endMin: number | null }
export interface ExceptionRow { exceptionDate: string; kind: 'UNAVAILABLE' | 'MODIFIED_HOURS'; startMin: number | null; endMin: number | null }
export interface UtcInterval { start: Date; end: Date }

export function normalize(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of normalize(a)) for (const y of normalize(b)) {
    const start = Math.max(x.start, y.start), end = Math.min(x.end, y.end);
    if (end > start) out.push({ start, end });
  }
  return normalize(out);
}

export function subtract(a: Interval[], cut: Interval[]): Interval[] {
  let out = normalize(a);
  for (const c of normalize(cut)) {
    out = out.flatMap((i) => {
      if (c.end <= i.start || c.start >= i.end) return [i];
      const parts: Interval[] = [];
      if (c.start > i.start) parts.push({ start: i.start, end: c.start });
      if (c.end < i.end) parts.push({ start: c.end, end: i.end });
      return parts;
    });
  }
  return out;
}

const weekly = (rows: WeeklyRow[], date: string): Interval[] =>
  rows.filter((r) => r.weekday === isoWeekday(date)).map((r) => ({ start: r.startMin, end: r.endMin }));

/** BR-042/043: weekly clinic hours for the weekday minus closures overlapping the date (full-day closures remove the day). */
export function clinicIntervals(date: string, hours: WeeklyRow[], closures: ClosureRow[]): Interval[] {
  const todays = closures.filter((c) => c.startDate <= date && c.endDate >= date);
  if (todays.some((c) => c.startMin === null)) return [];
  return subtract(weekly(hours, date), todays.map((c) => ({ start: c.startMin!, end: c.endMin! })));
}

/** BR-046/047: MODIFIED_HOURS replace the weekly schedule for that date; UNAVAILABLE subtracts (null range = full day). */
export function doctorIntervals(date: string, availability: WeeklyRow[], exceptions: ExceptionRow[]): Interval[] {
  const todays = exceptions.filter((e) => e.exceptionDate === date);
  const modified = todays.filter((e) => e.kind === 'MODIFIED_HOURS');
  const base = modified.length ? modified.map((e) => ({ start: e.startMin!, end: e.endMin! })) : weekly(availability, date);
  const unavailable = todays.filter((e) => e.kind === 'UNAVAILABLE');
  if (unavailable.some((e) => e.startMin === null)) return [];
  return subtract(base, unavailable.map((e) => ({ start: e.startMin!, end: e.endMin! })));
}

/** Converts local-minute intervals of a date to UTC instants (DST-safe, A-001). */
export function toUtc(date: string, intervals: Interval[], zone: string): UtcInterval[] {
  return intervals
    .map((i) => ({ start: localMinutesToUtc(date, i.start, zone), end: localMinutesToUtc(date, i.end, zone) }))
    .filter((i) => i.end > i.start);
}

/** Bookable intervals for a doctor on a date: C ∩ Dd (SRS 12.4), in UTC. */
export function bookableIntervals(input: {
  date: string; zone: string; clinicHours: WeeklyRow[]; closures: ClosureRow[]; availability: WeeklyRow[]; exceptions: ExceptionRow[];
}): UtcInterval[] {
  const c = clinicIntervals(input.date, input.clinicHours, input.closures);
  const d = doctorIntervals(input.date, input.availability, input.exceptions);
  return toUtc(input.date, intersect(c, d), input.zone);
}

/**
 * Candidate starts (SRS 12.4, BR-050/051): for each free interval [a, b) offer a, a+g, … while start + duration ≤ b.
 * `busy` are existing appointments (SC-2); `notBefore` applies minimum notice / now.
 */
export function slotStarts(free: UtcInterval[], durationMin: number, granularityMin: number, busy: UtcInterval[] = [], notBefore?: Date): Date[] {
  const ms = (d: Date) => d.getTime();
  const freeMs = subtract(free.map((f) => ({ start: ms(f.start), end: ms(f.end) })), busy.map((b) => ({ start: ms(b.start), end: ms(b.end) })));
  const out: Date[] = [];
  for (const f of freeMs) {
    for (let s = f.start; s + durationMin * 60_000 <= f.end; s += granularityMin * 60_000) {
      if (!notBefore || s >= ms(notBefore)) out.push(new Date(s));
    }
  }
  return out;
}

/** FR-DOC-004: doctor weekly time outside clinic weekly hours is saved but flagged and never bookable. */
export function outsideClinicHours(availability: WeeklyRow[], clinicHours: WeeklyRow[]): { weekday: number; start: number; end: number }[] {
  const out: { weekday: number; start: number; end: number }[] = [];
  for (let wd = 1; wd <= 7; wd++) {
    const d = availability.filter((r) => r.weekday === wd).map((r) => ({ start: r.startMin, end: r.endMin }));
    const c = clinicHours.filter((r) => r.weekday === wd).map((r) => ({ start: r.startMin, end: r.endMin }));
    for (const i of subtract(d, c)) out.push({ weekday: wd, ...i });
  }
  return out;
}
