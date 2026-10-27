import { z } from 'zod';

export const Uuid = z.string().uuid();
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
/** Local wall-clock time HH:MM; 24:00 allowed only as an end time. */
export const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Use HH:MM');
export const Weekday = z.number().int().min(1).max(7);
export const Email = z.string().email().max(254).transform((e) => e.toLowerCase());
export const Reason = z.string().min(3).max(200);

export function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
export function fromMinutes(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/**
 * One weekday of clinic hours (BR-040/041) or doctor schedule (BR-045):
 * CLOSED, or open < close on the same date with 0–3 non-overlapping breaks strictly inside.
 */
export const DaySchedule = z
  .object({
    weekday: Weekday,
    closed: z.boolean(),
    open: LocalTime.optional(),
    close: LocalTime.optional(),
    breaks: z.array(z.object({ start: LocalTime, end: LocalTime }).strict()).max(3, 'At most 3 breaks').default([]),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.closed) {
      if (d.open || d.close || d.breaks.length) ctx.addIssue({ code: 'custom', path: ['closed'], message: 'A closed day has no times' });
      return;
    }
    if (!d.open || !d.close) {
      ctx.addIssue({ code: 'custom', path: [d.open ? 'close' : 'open'], message: 'Required unless closed' });
      return;
    }
    const o = toMinutes(d.open), c = toMinutes(d.close);
    if (d.open === '24:00') ctx.addIssue({ code: 'custom', path: ['open'], message: 'Invalid opening time' });
    if (c <= o) ctx.addIssue({ code: 'custom', path: ['close'], message: 'Closing time must be after opening time' });
    const sorted = d.breaks.map((b, i) => ({ s: toMinutes(b.start), e: toMinutes(b.end), i })).sort((a, b) => a.s - b.s);
    sorted.forEach((b, k) => {
      if (b.e <= b.s) ctx.addIssue({ code: 'custom', path: ['breaks', b.i, 'end'], message: 'Break end must be after start' });
      else if (b.s <= o || b.e >= c) ctx.addIssue({ code: 'custom', path: ['breaks', b.i], message: 'Break must lie strictly within opening hours' });
      const prev = sorted[k - 1];
      if (prev && b.s < prev.e) ctx.addIssue({ code: 'custom', path: ['breaks', b.i], message: 'Breaks must not overlap' });
    });
  });
export type DaySchedule = z.infer<typeof DaySchedule>;

/** Whole week replaced atomically; weekdays not listed are CLOSED. */
export const WeekSchedule = z
  .object({ days: z.array(DaySchedule).max(7) })
  .strict()
  .refine((w) => new Set(w.days.map((d) => d.weekday)).size === w.days.length, { message: 'Each weekday at most once', path: ['days'] });
export type WeekSchedule = z.infer<typeof WeekSchedule>;

export interface MinuteInterval { startMin: number; endMin: number }

/** Converts a validated day into stored intervals (ADR-021: breaks are the gaps). */
export function dayToIntervals(d: DaySchedule): MinuteInterval[] {
  if (d.closed || !d.open || !d.close) return [];
  const out: MinuteInterval[] = [];
  let cursor = toMinutes(d.open);
  for (const b of [...d.breaks].sort((a, b) => toMinutes(a.start) - toMinutes(b.start))) {
    out.push({ startMin: cursor, endMin: toMinutes(b.start) });
    cursor = toMinutes(b.end);
  }
  out.push({ startMin: cursor, endMin: toMinutes(d.close) });
  return out;
}

/** Inverse of dayToIntervals, used by GET endpoints. */
export function intervalsToWeek(rows: { weekday: number; startMin: number; endMin: number }[]): DaySchedule[] {
  const days: DaySchedule[] = [];
  for (let wd = 1; wd <= 7; wd++) {
    const iv = rows.filter((r) => r.weekday === wd).sort((a, b) => a.startMin - b.startMin);
    const first = iv[0], last = iv[iv.length - 1];
    if (!first || !last) { days.push({ weekday: wd, closed: true, breaks: [] }); continue; }
    days.push({
      weekday: wd,
      closed: false,
      open: fromMinutes(first.startMin),
      close: fromMinutes(last.endMin),
      breaks: iv.slice(1).map((r, i) => ({ start: fromMinutes(iv[i]!.endMin), end: fromMinutes(r.startMin) })),
    });
  }
  return days;
}
