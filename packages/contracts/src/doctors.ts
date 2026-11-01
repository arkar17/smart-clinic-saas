import { z } from 'zod';
import { IsoDate, LocalTime, Uuid, toMinutes } from './common';
import { ScheduleExceptionKind } from './enums';

export const DoctorRequest = z
  .object({
    displayName: z.string().min(2).max(100),
    titleLabel: z.string().max(80).nullable(),
    isActive: z.boolean(),
    displayOrder: z.number().int().min(0).max(999),
    memberId: Uuid.nullable(),
  })
  .strict();
export const CreateDoctorRequest = DoctorRequest.partial({ titleLabel: true, isActive: true, displayOrder: true, memberId: true }).strict();
export const UpdateDoctorRequest = DoctorRequest.partial().strict();

/** FR-DOC-003 / BR-046 schedule exception. */
export const ExceptionRequest = z
  .object({
    exceptionDate: IsoDate,
    kind: ScheduleExceptionKind,
    startTime: LocalTime.nullable().optional(),
    endTime: LocalTime.nullable().optional(),
    reason: z.string().max(200).nullable().optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const hasRange = e.startTime != null || e.endTime != null;
    if (e.kind === 'MODIFIED_HOURS' && !hasRange) ctx.addIssue({ code: 'custom', path: ['startTime'], message: 'Modified hours need a start and end time' });
    if (!hasRange) return;
    if (e.startTime == null || e.endTime == null) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'Start and end time are both required' });
    else if (toMinutes(e.endTime) <= toMinutes(e.startTime)) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'End time must be after start time' });
  });

export const ScheduleQuery = z.object({ from: IsoDate, to: IsoDate }).strict();
