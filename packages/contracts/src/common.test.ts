import { describe, expect, it } from 'vitest';
import { DaySchedule, WeekSchedule, dayToIntervals, intervalsToWeek } from './common';
import { AddStaffRequest, SelectClinicRequest } from './index';
import { normalizeInput } from './normalize';
import { Slug } from './platform';

const bad = (d: unknown) => DaySchedule.safeParse(d).success;

describe('DaySchedule (BR-040/041, TC-CLN-001, TC-SCH-004)', () => {
  it('accepts open/close with up to three breaks and converts to four intervals', () => {
    const d = DaySchedule.parse({ weekday: 1, closed: false, open: '08:00', close: '18:00', breaks: [{ start: '10:00', end: '10:15' }, { start: '12:00', end: '13:00' }, { start: '15:00', end: '15:15' }] });
    expect(dayToIntervals(d)).toEqual([
      { startMin: 480, endMin: 600 }, { startMin: 615, endMin: 720 }, { startMin: 780, endMin: 900 }, { startMin: 915, endMin: 1080 },
    ]);
  });
  it('rejects close ≤ open, breaks outside hours, overlapping breaks and a fourth break (fifth interval)', () => {
    expect(bad({ weekday: 1, closed: false, open: '18:00', close: '09:00' })).toBe(false);
    expect(bad({ weekday: 1, closed: false, open: '09:00', close: '09:00' })).toBe(false);
    expect(bad({ weekday: 1, closed: false, open: '09:00', close: '17:00', breaks: [{ start: '08:00', end: '09:30' }] })).toBe(false);
    expect(bad({ weekday: 1, closed: false, open: '09:00', close: '17:00', breaks: [{ start: '12:00', end: '13:00' }, { start: '12:30', end: '13:30' }] })).toBe(false);
    const four = ['10', '11', '12', '13'].map((h) => ({ start: `${h}:00`, end: `${h}:15` }));
    expect(bad({ weekday: 1, closed: false, open: '09:00', close: '17:00', breaks: four })).toBe(false);
  });
  it('field errors point at the offending path', () => {
    const r = DaySchedule.safeParse({ weekday: 1, closed: false, open: '18:00', close: '09:00' });
    expect(r.success || r.error.issues[0]?.path).toEqual(['close']);
  });
  it('week round-trips; missing weekdays are CLOSED; duplicates rejected', () => {
    const week = WeekSchedule.parse({ days: [{ weekday: 2, closed: false, open: '09:00', close: '18:00', breaks: [{ start: '12:00', end: '13:00' }] }] });
    const rows = week.days.flatMap((d) => dayToIntervals(d).map((i) => ({ weekday: d.weekday, ...i })));
    const back = intervalsToWeek(rows);
    expect(back[1]).toEqual(week.days[0]);
    expect(back[0]).toEqual({ weekday: 1, closed: true, breaks: [] });
    expect(WeekSchedule.safeParse({ days: [{ weekday: 1, closed: true }, { weekday: 1, closed: true }] }).success).toBe(false);
  });
});

describe('strict contracts and normalisation (FR-SEC-008, TC-VAL-003, TC-SEC-017)', () => {
  it('rejects unknown fields such as clinicId', () => {
    expect(AddStaffRequest.safeParse({ email: 'a@example.test', displayName: 'Ann', roles: ['RECEPTIONIST'], clinicId: 'x' }).success).toBe(false);
    expect(SelectClinicRequest.safeParse({ clinicId: '6f1c7a52-6a0c-4f43-9d55-1c3b8d0d1d11', extra: 1 }).success).toBe(false);
  });
  it('NFC-normalises and trims strings but never trims passwords', () => {
    const out = normalizeInput({ name: '  Café  ', password: '  secret  ', nested: [{ label: ' x ' }] }) as Record<string, unknown>;
    expect(out.name).toBe('Café');
    expect(out.password).toBe('  secret  ');
    expect(out.nested).toEqual([{ label: 'x' }]);
  });
  it('BR-010 slug rules', () => {
    for (const ok of ['sunrise-clinic', 'abc', 'a1-b2']) expect(Slug.safeParse(ok).success).toBe(true);
    for (const no of ['ab', 'Sunrise', '-abc', 'abc-', 'a--b', 'admin', 'api', 'x'.repeat(41)]) expect(Slug.safeParse(no).success).toBe(false);
  });
});
