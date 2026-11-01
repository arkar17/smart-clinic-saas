import { describe, expect, it } from 'vitest';
import { bookableIntervals, clinicIntervals, doctorIntervals, intersect, outsideClinicHours, slotStarts, toUtc, type WeeklyRow } from './availability';
import { clinicToday, localMinutesToUtc } from '../../infra/time';

const hm = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const day = (weekday: number, ...pairs: [string, string][]): WeeklyRow[] => pairs.map(([s, e]) => ({ weekday, startMin: hm(s), endMin: hm(e) }));
const local = (d: Date, zone: string) => d.toLocaleTimeString('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit' });
const MONDAY = '2026-11-02';
const BKK = 'Asia/Bangkok';

describe('SRS 12.5 worked example', () => {
  it('produces exactly the documented starts', () => {
    const free = bookableIntervals({
      date: MONDAY, zone: BKK, closures: [], exceptions: [],
      clinicHours: day(1, ['09:00', '12:00'], ['13:00', '18:00']),
      availability: day(1, ['10:00', '14:30'], ['15:00', '16:00']),
    });
    const booked = toUtc(MONDAY, [{ start: hm('10:30'), end: hm('11:00') }], BKK);
    const starts = slotStarts(free, 30, 15, booked).map((d) => local(d, BKK));
    expect(starts).toEqual(['10:00', '11:00', '11:15', '11:30', '13:00', '13:15', '13:30', '13:45', '14:00', '15:00', '15:15', '15:30']);
  });
});

describe('doctor schedules (TC-DOC-001, TC-DOC-002, TC-SCH-004)', () => {
  const clinic = day(1, ['09:00', '18:00']);
  it('TC-DOC-001: doctor 08:00–19:00 vs clinic 09:00–18:00 → warning and slots only 09:00–18:00', () => {
    const doctor = day(1, ['08:00', '19:00']);
    expect(outsideClinicHours(doctor, clinic)).toEqual([{ weekday: 1, start: 480, end: 540 }, { weekday: 1, start: 1080, end: 1140 }]);
    const starts = slotStarts(bookableIntervals({ date: MONDAY, zone: BKK, clinicHours: clinic, closures: [], availability: doctor, exceptions: [] }), 30, 30);
    expect(local(starts[0]!, BKK)).toBe('09:00');
    expect(local(starts[starts.length - 1]!, BKK)).toBe('17:30');
  });
  it('TC-DOC-002: UNAVAILABLE 10:00–12:00 removes that range for this doctor only', () => {
    const avail = day(1, ['09:00', '18:00']);
    const ex = [{ exceptionDate: MONDAY, kind: 'UNAVAILABLE' as const, startMin: hm('10:00'), endMin: hm('12:00') }];
    expect(doctorIntervals(MONDAY, avail, ex)).toEqual([{ start: hm('09:00'), end: hm('10:00') }, { start: hm('12:00'), end: hm('18:00') }]);
    expect(doctorIntervals(MONDAY, avail, [])).toEqual([{ start: hm('09:00'), end: hm('18:00') }]);
    expect(doctorIntervals(MONDAY, avail, [{ exceptionDate: MONDAY, kind: 'UNAVAILABLE', startMin: null, endMin: null }])).toEqual([]);
  });
  it('TC-SCH-004: three breaks (four intervals) → slots only inside intervals', () => {
    const avail = day(1, ['09:00', '10:00'], ['10:30', '12:00'], ['13:00', '15:00'], ['15:30', '17:00']);
    const starts = slotStarts(bookableIntervals({ date: MONDAY, zone: BKK, clinicHours: clinic, closures: [], availability: avail, exceptions: [] }), 30, 30).map((d) => local(d, BKK));
    expect(starts).toEqual(['09:00', '09:30', '10:30', '11:00', '11:30', '13:00', '13:30', '14:00', '14:30', '15:30', '16:00', '16:30']);
  });
});

describe('clinic hours and closures (TC-SCH-005, TC-SCH-006)', () => {
  it('TC-SCH-005: (clinic − closures) ∩ modified hours', () => {
    const hours = day(1, ['09:00', '18:00']).concat(day(2, ['09:00', '18:00']), day(3, ['09:00', '18:00']));
    const closures = [
      { startDate: '2026-11-03', endDate: '2026-11-04', startMin: null, endMin: null }, // multi-day full closure (Tue–Wed)
      { startDate: MONDAY, endDate: MONDAY, startMin: hm('12:00'), endMin: hm('14:00') }, // partial Monday
    ];
    const exceptions = [{ exceptionDate: MONDAY, kind: 'MODIFIED_HOURS' as const, startMin: hm('11:00'), endMin: hm('16:00') }];
    const c = clinicIntervals(MONDAY, hours, closures);
    const d = doctorIntervals(MONDAY, day(1, ['09:00', '18:00']), exceptions);
    expect(intersect(c, d)).toEqual([{ start: hm('11:00'), end: hm('12:00') }, { start: hm('14:00'), end: hm('16:00') }]);
    expect(clinicIntervals('2026-11-03', hours, closures)).toEqual([]);
    expect(clinicIntervals('2026-11-04', hours, closures)).toEqual([]);
  });
  it('TC-SCH-006: a weekday with no rows is CLOSED → no slots', () => {
    const free = bookableIntervals({ date: '2026-11-08', zone: BKK, clinicHours: day(1, ['09:00', '18:00']), closures: [], availability: day(7, ['09:00', '18:00']), exceptions: [] });
    expect(free).toEqual([]);
    expect(slotStarts(free, 15, 15)).toEqual([]);
  });
});

describe('time zones and DST (TC-SCH-001..003)', () => {
  it('TC-SCH-001: Europe/London spring-forward 00:30–03:00 skips the missing hour', () => {
    const [iv] = toUtc('2026-03-29', [{ start: hm('00:30'), end: hm('03:00') }], 'Europe/London');
    expect(iv!.start.toISOString()).toBe('2026-03-29T00:30:00.000Z');
    expect(iv!.end.toISOString()).toBe('2026-03-29T02:00:00.000Z');
    const starts = slotStarts([iv!], 30, 30).map((d) => d.toISOString());
    expect(starts).toEqual(['2026-03-29T00:30:00.000Z', '2026-03-29T01:00:00.000Z', '2026-03-29T01:30:00.000Z']);
    expect(starts.map((s) => local(new Date(s), 'Europe/London'))).toEqual(['00:30', '02:00', '02:30']);
    expect(localMinutesToUtc('2026-03-29', hm('01:30'), 'Europe/London').toISOString()).toBe('2026-03-29T01:00:00.000Z');
  });
  it('TC-SCH-002: Europe/London fall-back ambiguous 01:30 resolves to the first occurrence', () => {
    expect(localMinutesToUtc('2026-10-25', hm('01:30'), 'Europe/London').toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });
  it('TC-SCH-003: Asia/Bangkok 09:00 → 02:00Z and "today" switches at 17:00Z', () => {
    expect(localMinutesToUtc(MONDAY, hm('09:00'), BKK).toISOString()).toBe('2026-11-02T02:00:00.000Z');
    expect(clinicToday(new Date('2026-11-02T16:59:59Z'), BKK)).toBe('2026-11-02');
    expect(clinicToday(new Date('2026-11-02T17:00:00Z'), BKK)).toBe('2026-11-03');
    expect(localMinutesToUtc(MONDAY, 1440, BKK).toISOString()).toBe('2026-11-02T17:00:00.000Z');
  });
});
