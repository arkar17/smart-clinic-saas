import { z } from 'zod';
import { IsoDate, LocalTime, toMinutes } from './common';
import { PhoneRegion, Slug, TimeZone } from './platform';

export const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'Use international format, e.g. +66812345678');

export const UpdateProfileRequest = z
  .object({
    name: z.string().min(2).max(120),
    slug: Slug,
    address: z.string().max(300).nullable(),
    contactPhone: E164.nullable(),
    timezone: TimeZone,
    defaultPhoneRegion: PhoneRegion,
    privacyNotice: z.string().max(5000).nullable(),
  })
  .partial()
  .strict();

const int = (min: number, max: number) => z.number().int().min(min).max(max);
/** FR-CLN-005 booking settings and FR-CLN-006 walk-in settings (enforcement of walk-in rules is SC-3). */
export const UpdateSettingsRequest = z
  .object({
    slotGranularityMin: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(60)]),
    holdMinutes: int(5, 30),
    minNoticeMin: int(0, 1440),
    horizonDays: int(1, 90),
    cancelCutoffMin: int(0, 2880),
    checkinBeforeMin: int(0, 240),
    checkinAfterMin: int(0, 240),
    noShowGraceMin: int(0, 240),
    maxActiveBookings: int(1, 20),
    walkinEnabled: z.boolean(),
    walkinDailyCapacity: int(1, 500).nullable(),
    walkinOpensOffsetMin: int(-240, 720),
    walkinClosesBeforeMin: int(0, 720),
  })
  .partial()
  .strict();

export const ClosureRequest = z
  .object({
    startDate: IsoDate,
    endDate: IsoDate,
    startTime: LocalTime.nullable().optional(),
    endTime: LocalTime.nullable().optional(),
    label: z.string().max(80).nullable().optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.endDate < c.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'End date must not be before start date' });
    const partial = c.startTime != null || c.endTime != null;
    if (!partial) return;
    if (c.startTime == null || c.endTime == null) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'A partial closure needs a start and end time' });
    else if (toMinutes(c.endTime) <= toMinutes(c.startTime)) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'End time must be after start time' });
    if (c.startDate !== c.endDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'A partial closure covers a single date' });
  });
