import { z } from 'zod';
import { Reason, Uuid } from './common';
import { FullName, PhoneInput } from './patients';

export const QueueStatus = z.enum(['REGISTERED', 'WAITING', 'CALLED', 'IN_CONSULTATION', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED']);
export type QueueStatus = z.infer<typeof QueueStatus>;
export type QueueAction = 'CONFIRM_ARRIVAL' | 'CALL' | 'START' | 'COMPLETE' | 'RETURN_TO_WAITING' | 'NO_SHOW' | 'CANCEL' | 'REASSIGN';

/** SRS 9.3 transitions available to staff and patients (QT-03..QT-12); system day close is separate. */
export const QUEUE_TRANSITIONS: Record<QueueAction, { from: QueueStatus[]; to: QueueStatus }> = {
  CONFIRM_ARRIVAL: { from: ['REGISTERED'], to: 'WAITING' }, // QT-03
  CALL: { from: ['WAITING'], to: 'CALLED' }, // QT-06
  START: { from: ['CALLED'], to: 'IN_CONSULTATION' }, // QT-09
  COMPLETE: { from: ['IN_CONSULTATION'], to: 'COMPLETED' }, // QT-12
  RETURN_TO_WAITING: { from: ['CALLED'], to: 'WAITING' }, // QT-10
  NO_SHOW: { from: ['CALLED'], to: 'NO_SHOW' }, // QT-11
  CANCEL: { from: ['REGISTERED', 'WAITING'], to: 'CANCELLED' }, // QT-04 / QT-07
  REASSIGN: { from: ['WAITING'], to: 'WAITING' }, // QT-08
};
export const RECALL_LIMIT = 3; // A-020
export const TERMINAL_QUEUE_STATUSES: QueueStatus[] = ['COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED'];

/** Pure transition check (ADR-016 layer 1). Returns the target status or null when not allowed. */
export function queueTransition(from: QueueStatus, action: QueueAction, ctx: { recallCount?: number } = {}): QueueStatus | 'RECALL_LIMIT' | null {
  const t = QUEUE_TRANSITIONS[action];
  if (!t.from.includes(from)) return null;
  if (action === 'RETURN_TO_WAITING' && (ctx.recallCount ?? 0) >= RECALL_LIMIT) return 'RECALL_LIMIT';
  return t.to;
}

export const formatToken = (n: number) => String(n).padStart(3, '0'); // BR-021

/** Public QR walk-in (FR-QUE-003): name, phone and privacy acknowledgement always required; no bypass. */
export const PublicWalkInRequest = z
  .object({ serviceId: Uuid, doctorId: Uuid, fullName: z.string().max(200), phone: PhoneInput, privacyAccepted: z.literal(true, { errorMap: () => ({ message: 'Please accept the privacy notice' }) }) })
  .strict();
/** Staff walk-in (FR-QUE-006). The no-phone exception (FR-QUE-020, SHOULD) is deferred. */
export const StaffWalkInRequest = z.object({ serviceId: Uuid, doctorId: Uuid, fullName: FullName, phone: PhoneInput, overrideReason: Reason.optional() }).strict();
export const VersionBody = z.object({ version: z.number().int().min(0).optional() }).strict();
export const ReasonVersionBody = z.object({ reason: Reason, version: z.number().int().min(0).optional() }).strict();
export const OptionalReasonVersionBody = z.object({ reason: Reason.optional(), version: z.number().int().min(0).optional() }).strict();
export const ReassignBody = z.object({ doctorId: Uuid, version: z.number().int().min(0).optional() }).strict();
export const CheckInBody = z.object({ overrideReason: Reason.optional(), version: z.number().int().min(0).optional() }).strict();
export const QueueTodayQuery = z.object({ doctorId: Uuid.optional() }).strict();

export type WalkInIneligibleReason = 'CLOSED_TODAY' | 'NOT_YET_OPEN' | 'AFTER_CUTOFF' | 'PAUSED' | 'DISABLED' | 'FULL' | 'NO_SERVICE';

/** GET /api/public/queue-entry (FR-QUE-014): own entry only. */
export interface PublicQueueStatus {
  token: string;
  status: QueueStatus;
  statusText: string;
  doctor: string;
  clinic: { name: string; slug: string; timezone: string };
  nowServingToken: string | null;
  peopleAhead: number | null;
  canLeave: boolean;
}
