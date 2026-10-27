import { DateTime } from 'luxon';

/** Clinic-local "today" (Arch 12.6). */
export function clinicToday(now: Date, zone: string): string {
  return DateTime.fromJSDate(now, { zone }).toISODate()!;
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a local date. */
export function isoWeekday(date: string): number {
  return DateTime.fromISO(date, { zone: 'UTC' }).weekday;
}

export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: 'UTC' }).plus({ days }).toISODate()!;
}

/**
 * Resolves local minutes-after-midnight on a clinic date to a UTC instant (SRS 12.1, A-001).
 * Nonexistent times (DST gap) resolve to the end of the gap so no instants are produced inside it;
 * ambiguous times (DST overlap) resolve to the first occurrence (earlier offset).
 */
export function localMinutesToUtc(date: string, minutes: number, zone: string): Date {
  const day = DateTime.fromISO(date, { zone });
  for (let m = minutes; m <= minutes + 180; m++) {
    const target = { hour: Math.floor(m / 60), minute: m % 60 };
    const base = target.hour >= 24 ? day.plus({ days: 1 }).set({ hour: target.hour - 24, minute: target.minute }) : day.set(target);
    const hourWanted = target.hour % 24;
    if (base.hour === hourWanted && base.minute === target.minute) {
      // Prefer the earlier offset when the wall time occurs twice.
      const earlier = base.minus({ hours: 1 });
      if (earlier.hour === base.hour && earlier.minute === base.minute) return earlier.toUTC().toJSDate();
      return base.toUTC().toJSDate();
    }
  }
  throw new Error(`Cannot resolve ${date} ${minutes} in ${zone}`);
}
