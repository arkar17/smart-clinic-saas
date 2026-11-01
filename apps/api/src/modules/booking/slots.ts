import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { AppError, notFound } from '../../infra/errors';
import { fromDate, toDate } from '../../infra/http';
import { addDays, clinicToday } from '../../infra/time';
import { bookableIntervals, slotStarts, type ClosureRow, type ExceptionRow, type UtcInterval } from '../scheduling/index';

type Db = PrismaClient | Prisma.TransactionClient;
type Clinic = Prisma.ClinicGetPayload<object>;
export type Mode = 'PUBLIC' | 'STAFF';
const BLOCKING = ['CONFIRMED', 'CHECKED_IN', 'COMPLETED'] as const;

/** SRS 12.4 first step: service and doctor must belong to the clinic (else 404), be active and eligible. */
export async function bookingContext(db: Db, clinicId: string, serviceId: string, doctorId: string, mode: Mode) {
  const [service, doctor] = await Promise.all([
    db.clinicService.findFirst({ where: { id: serviceId, clinicId } }),
    db.doctor.findFirst({ where: { id: doctorId, clinicId }, include: { availability: true, services: { where: { serviceId } } } }),
  ]);
  if (!service || !doctor) throw notFound();
  if (!service.isActive || (mode === 'PUBLIC' && !service.onlineBookingEnabled)) throw new AppError('SERVICE_NOT_BOOKABLE', 'This service cannot be booked.');
  if (!doctor.isActive || doctor.services.length === 0) throw new AppError('DOCTOR_NOT_ELIGIBLE', 'This doctor is not available for this service.');
  return { service, doctor };
}
export type BookingContext = Awaited<ReturnType<typeof bookingContext>>;

/** B in SRS 12.4: doctor's CONFIRMED/CHECKED_IN/COMPLETED and unexpired PENDING appointments (expired holds never block, FR-APT-014). */
export async function loadBusy(db: Db, clinicId: string, doctorId: string, from: Date, to: Date, now: Date, excludeIds: string[] = []): Promise<UtcInterval[]> {
  const rows = await db.appointment.findMany({
    where: {
      clinicId, doctorId, startAt: { lt: to }, endAt: { gt: from }, id: { notIn: excludeIds },
      OR: [{ status: { in: [...BLOCKING] } }, { status: 'PENDING', holdExpiresAt: { gt: now } }],
    },
    select: { startAt: true, endAt: true },
  });
  return rows.map((r) => ({ start: r.startAt, end: r.endAt }));
}

/** Slot starts per clinic-local date in [from, to] (Arch 16). PUBLIC applies minimum notice; STAFF only "now" (A-018). */
export async function computeSlots(db: Db, clinic: Clinic, ctx: BookingContext, from: string, to: string, now: Date, mode: Mode, excludeIds: string[] = []) {
  const today = clinicToday(now, clinic.timezone);
  const lastDay = addDays(today, clinic.horizonDays);
  const start = from < today ? today : from;
  const end = to > lastDay ? lastDay : to;
  const out = new Map<string, Date[]>();
  if (end < start) return out;
  const [hours, closures, exceptions] = await Promise.all([
    db.clinicBusinessHour.findMany({ where: { clinicId: clinic.id } }),
    db.clinicClosure.findMany({ where: { clinicId: clinic.id, startDate: { lte: toDate(end) }, endDate: { gte: toDate(start) } } }),
    db.scheduleException.findMany({ where: { clinicId: clinic.id, doctorId: ctx.doctor.id, exceptionDate: { gte: toDate(start), lte: toDate(end) } } }),
  ]);
  const cl: ClosureRow[] = closures.map((c) => ({ startDate: fromDate(c.startDate), endDate: fromDate(c.endDate), startMin: c.startMin, endMin: c.endMin }));
  const ex: ExceptionRow[] = exceptions.map((e) => ({ exceptionDate: fromDate(e.exceptionDate), kind: e.kind, startMin: e.startMin, endMin: e.endMin }));
  const busy = await loadBusy(db, clinic.id, ctx.doctor.id, new Date(Date.parse(`${start}T00:00:00Z`) - 86_400_000), new Date(Date.parse(`${end}T00:00:00Z`) + 2 * 86_400_000), now, excludeIds);
  const notBefore = mode === 'PUBLIC' ? new Date(now.getTime() + clinic.minNoticeMin * 60_000) : now; // BR-052 / A-018
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const free = bookableIntervals({ date, zone: clinic.timezone, clinicHours: hours, closures: cl, availability: ctx.doctor.availability, exceptions: ex });
    out.set(date, slotStarts(free, ctx.service.durationMin, clinic.slotGranularityMin, busy, notBefore));
  }
  return out;
}

/** Validates a requested start against the computed slots (hold, confirm re-validation, staff create, reschedule). */
export async function assertSlot(db: Db, clinic: Clinic, ctx: BookingContext, startAt: Date, now: Date, mode: Mode, excludeIds: string[] = []) {
  const serviceDate = clinicToday(startAt, clinic.timezone);
  const slots = (await computeSlots(db, clinic, ctx, serviceDate, serviceDate, now, mode, excludeIds)).get(serviceDate) ?? [];
  if (!slots.some((s) => s.getTime() === startAt.getTime())) throw new AppError('SLOT_UNAVAILABLE', 'This time is no longer available. Please choose another.');
  return { serviceDate, endAt: new Date(startAt.getTime() + ctx.service.durationMin * 60_000) };
}

/** Arch 12.1: inside every insert/move, overlapping stale holds are expired first (the constraint cannot use now()). */
export function expireStaleHolds(tx: Prisma.TransactionClient, doctorId: string, startAt: Date, endAt: Date, now: Date) {
  return tx.$executeRaw`
    UPDATE appointment SET status = 'EXPIRED', expired_at = ${now}, reservation_secret_hash = NULL, hold_ip_hash = NULL, version = version + 1
    WHERE doctor_id = ${doctorId}::uuid AND status = 'PENDING' AND hold_expires_at <= ${now}
      AND tstzrange(start_at, end_at, '[)') && tstzrange(${startAt}, ${endAt}, '[)')`;
}

export { retryOnDeadlock } from '../../infra/db';
