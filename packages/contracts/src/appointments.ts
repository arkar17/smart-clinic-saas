import { z } from 'zod';
import { IsoDate, Reason, Uuid } from './common';
import { FullName, PhoneInput } from './patients';

export const AppointmentStatus = z.enum(['PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED']);
export type AppointmentStatus = z.infer<typeof AppointmentStatus>;
const Instant = z.string().datetime({ offset: true });

/** POST /public/clinics/:slug/reservations (AT-01). */
export const HoldRequest = z.object({ serviceId: Uuid, doctorId: Uuid, startAt: Instant }).strict();
/** POST …/reservations/:id/confirm (AT-02). Name and phone are always required (BR-037). */
export const ConfirmRequest = z
  .object({ reservationSecret: z.string().min(16).max(64), fullName: z.string().max(200), phone: PhoneInput, privacyAccepted: z.literal(true, { errorMap: () => ({ message: 'Please accept the privacy notice' }) }) })
  .strict();
export const ReleaseRequest = z.object({ reservationSecret: z.string().min(16).max(64) }).strict();
export const EmptyRequest = z.object({}).strict();

/** Staff (FR-APT-010, -011, -015). */
export const StaffCreateAppointmentRequest = z.object({ serviceId: Uuid, doctorId: Uuid, startAt: Instant, fullName: FullName, phone: PhoneInput }).strict();
export const RescheduleRequest = z.object({ startAt: Instant, doctorId: Uuid.optional(), version: z.number().int().min(0) }).strict();
export const StaffCancelRequest = z.object({ reason: Reason, version: z.number().int().min(0) }).strict();
export const AppointmentListQuery = z
  .object({ from: IsoDate, to: IsoDate.optional(), doctorId: Uuid.optional(), serviceId: Uuid.optional(), status: AppointmentStatus.optional() })
  .strict();
export const StaffSlotsQuery = z.object({ serviceId: Uuid, doctorId: Uuid, date: IsoDate, excludeAppointmentId: Uuid.optional() }).strict();

/** GET /api/public/booking (FR-APT-008): first name and masked phone only. */
export interface PublicBooking {
  clinic: { name: string; slug: string; contactPhone: string | null; timezone: string; suspended: boolean };
  service: { name: string; durationMin: number };
  doctor: { displayName: string; titleLabel: string | null };
  startAt: string;
  endAt: string;
  status: AppointmentStatus;
  bookingReference: string;
  patient: { firstName: string; maskedPhone: string };
  cancellation: { allowed: boolean; cutoffAt: string };
}
