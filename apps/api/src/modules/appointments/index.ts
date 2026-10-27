import { Router, type Request } from 'express';
import { CheckInBody, VersionBody, formatToken, AppointmentListQuery, RescheduleRequest, StaffCancelRequest, StaffCreateAppointmentRequest, StaffSlotsQuery } from '@sc/contracts';
import type { Prisma } from '../../generated/prisma/index.js';
import { AppError, notFound } from '../../infra/errors';
import { fromDate, h, toDate, uuidParam } from '../../infra/http';
import { parse } from '../../infra/validate';
import { addDays, clinicToday } from '../../infra/time';
import type { Deps } from '../../infra/context';
import { writeAudit } from '../audit/index';
import { assertDoctorScope, grantOf, staffChain } from '../identity/index';
import { findOrCreatePatient, validatePatientIdentity } from '../patients/index';
import { TX, retryOnDeadlock, assertSlot, bookingContext, bookingLinkExpiry, computeSlots, expireStaleHolds, freshReference, issueBookingToken, privateBookingUrl } from '../booking/index';
import { bookableIntervals } from '../scheduling/index';
import { allocateEntry } from '../queue/index';
import { emitEvent } from '../realtime/index';

const include = { service: { select: { id: true, name: true, durationMin: true } }, doctor: { select: { id: true, displayName: true } }, patient: { select: { id: true, fullName: true, phoneE164: true } } } as const;
type Row = Prisma.AppointmentGetPayload<{ include: typeof include }>;
const view = (a: Row) => ({
  id: a.id, status: a.status, channel: a.channel, bookingReference: a.bookingReference, serviceDate: fromDate(a.serviceDate), startAt: a.startAt, endAt: a.endAt,
  service: a.service, doctor: a.doctor, patient: a.patient ? { id: a.patient.id, fullName: a.patient.fullName, phone: a.patient.phoneE164 } : null,
  cancelledAt: a.cancelledAt, cancelledBy: a.cancelledBy, cancelReason: a.cancelReason, version: a.version,
});

/** Staff appointment management (FR-APT-010, -011, -015, -016; CAP-APT-03..06, -09). Check-in and no-show arrive with the SC-3 queue. */
export function appointmentRoutes(deps: Deps): { appointments: Router; availability: Router } {
  const { prisma, clock } = deps;
  const appointments = Router();
  const availability = Router();
  const loadClinic = (req: Request) => prisma.clinic.findFirstOrThrow({ where: { id: req.clinic!.clinicId } });
  const load = async (req: Request, id: string) => {
    const a = await prisma.appointment.findFirst({ where: { id, clinicId: req.clinic!.clinicId, status: { notIn: ['PENDING', 'EXPIRED'] } }, include });
    if (!a) throw notFound();
    assertDoctorScope(req, a.doctorId); // DR: own appointments only (ALLOW_OWN)
    return a;
  };

  // Staff slots: no minimum notice (A-018); horizon still applies.
  availability.get('/slots', ...staffChain(deps, 'CAP-APT-03', 'write'), h(async (req, res) => {
    const q = parse(StaffSlotsQuery, req.query);
    const c = await loadClinic(req);
    const ctx = await bookingContext(prisma, c.id, q.serviceId, q.doctorId, 'STAFF');
    const out = await computeSlots(prisma, c, ctx, q.date, q.date, clock.now(), 'STAFF', q.excludeAppointmentId ? [q.excludeAppointmentId] : []);
    res.json({ date: q.date, timezone: c.timezone, slots: (out.get(q.date) ?? []).map((s) => ({ startAt: s.toISOString(), endAt: new Date(s.getTime() + ctx.service.durationMin * 60_000).toISOString() })) });
  }));

  // FR-APT-015: day list per doctor and filterable list.
  appointments.get('/', ...staffChain(deps, 'CAP-APT-04', 'read'), h(async (req, res) => {
    const q = parse(AppointmentListQuery, req.query);
    const ctx = req.clinic!;
    const to = q.to ?? q.from;
    if (to < q.from || addDays(q.from, 92) < to) throw new AppError('VALIDATION_ERROR', undefined, { fields: { to: ['Range must be 0–92 days'] } });
    const where: Prisma.AppointmentWhereInput = {
      clinicId: ctx.clinicId, serviceDate: { gte: toDate(q.from), lte: toDate(to) },
      status: q.status ? q.status : { notIn: ['PENDING', 'EXPIRED'] }, doctorId: q.doctorId, serviceId: q.serviceId,
    };
    if (grantOf(req) === 'OWN') where.doctorId = ctx.doctorId ?? '00000000-0000-0000-0000-000000000000';
    const rows = await prisma.appointment.findMany({ where, include, orderBy: [{ startAt: 'asc' }] });
    res.json({ timezone: ctx.timezone, items: rows.map(view) });
  }));

  // FR-APT-016 / ADR-032: future CONFIRMED appointments that no longer fit current rules, computed on read.
  appointments.get('/conflicts', ...staffChain(deps, 'CAP-APT-09', 'read'), h(async (req, res) => {
    const c = await loadClinic(req);
    const now = clock.now();
    const rows = await prisma.appointment.findMany({ where: { clinicId: c.id, status: 'CONFIRMED', startAt: { gt: now } }, include, orderBy: { startAt: 'asc' } });
    const [hours, closures, availabilityRows, exceptions] = await Promise.all([
      prisma.clinicBusinessHour.findMany({ where: { clinicId: c.id } }),
      prisma.clinicClosure.findMany({ where: { clinicId: c.id, endDate: { gte: toDate(clinicToday(now, c.timezone)) } } }),
      prisma.doctorAvailability.findMany({ where: { clinicId: c.id } }),
      prisma.scheduleException.findMany({ where: { clinicId: c.id, exceptionDate: { gte: toDate(clinicToday(now, c.timezone)) } } }),
    ]);
    const cl = closures.map((x) => ({ startDate: fromDate(x.startDate), endDate: fromDate(x.endDate), startMin: x.startMin, endMin: x.endMin }));
    const conflicts = rows.filter((a) => {
      const date = fromDate(a.serviceDate);
      const free = bookableIntervals({
        date, zone: c.timezone, clinicHours: hours, closures: cl,
        availability: availabilityRows.filter((x) => x.doctorId === a.doctorId),
        exceptions: exceptions.filter((x) => x.doctorId === a.doctorId).map((x) => ({ exceptionDate: fromDate(x.exceptionDate), kind: x.kind, startMin: x.startMin, endMin: x.endMin })),
      });
      return !free.some((f) => f.start <= a.startAt && f.end >= a.endAt);
    });
    res.json({ timezone: c.timezone, items: conflicts.map(view) });
  }));

  appointments.get('/:id', ...staffChain(deps, 'CAP-APT-04', 'read'), h(async (req, res) => res.json(view(await load(req, uuidParam(req, 'id'))))));

  // AT-05 staff create: directly CONFIRMED; same overlap constraint; reference and private link issued.
  appointments.post('/', ...staffChain(deps, 'CAP-APT-03', 'write'), h(async (req, res) => {
    const body = parse(StaffCreateAppointmentRequest, req.body);
    const c = await loadClinic(req);
    const ctx = req.clinic!;
    const identity = validatePatientIdentity({ fullName: body.fullName, phone: body.phone }, c.defaultPhoneRegion);
    const now = clock.now();
    const startAt = new Date(body.startAt);
    const bctx = await bookingContext(prisma, c.id, body.serviceId, body.doctorId, 'STAFF');
    const { endAt, serviceDate } = await assertSlot(prisma, c, bctx, startAt, now, 'STAFF');
    const out = await retryOnDeadlock(() => prisma.$transaction(async (tx) => {
      await expireStaleHolds(tx, bctx.doctor.id, startAt, endAt, now);
      const { patient } = await findOrCreatePatient(tx, c.id, identity, 'STAFF', now);
      const a = await tx.appointment.create({
        data: {
          clinicId: c.id, doctorId: bctx.doctor.id, serviceId: bctx.service.id, patientId: patient.id, channel: 'STAFF', status: 'CONFIRMED',
          serviceDate: toDate(serviceDate), startAt, endAt, bookingReference: await freshReference(tx, c.id), confirmedAt: now, createdByMemberId: ctx.memberId, createdAt: now,
        },
      });
      const token = await issueBookingToken(tx, c.id, a.id, startAt, now, ctx.memberId);
      await writeAudit(tx, req, now, { clinicId: c.id, action: 'appointment.created', entityType: 'appointment', entityId: a.id, toStatus: 'CONFIRMED' });
      return { id: a.id, token };
    }, TX));
    res.status(201).json({ appointment: view(await load(req, out.id)), privateUrl: privateBookingUrl(deps, c.slug, out.token) });
  }));

  // AT-06 reschedule: one conditional UPDATE (ADR-007); on 23P01 the transaction rolls back and the original is unchanged.
  appointments.post('/:id/reschedule', ...staffChain(deps, 'CAP-APT-05', 'write'), h(async (req, res) => {
    const body = parse(RescheduleRequest, req.body);
    const c = await loadClinic(req);
    const ctx = req.clinic!;
    const a = await load(req, uuidParam(req, 'id'));
    if (a.status !== 'CONFIRMED') throw new AppError('INVALID_TRANSITION', 'Only confirmed appointments can be rescheduled.', { current: { version: a.version } });
    const now = clock.now();
    const startAt = new Date(body.startAt);
    const bctx = await bookingContext(prisma, c.id, a.serviceId, body.doctorId ?? a.doctorId, 'STAFF');
    const { endAt, serviceDate } = await assertSlot(prisma, c, bctx, startAt, now, 'STAFF', [a.id]);
    await retryOnDeadlock(() => prisma.$transaction(async (tx) => {
      await expireStaleHolds(tx, bctx.doctor.id, startAt, endAt, now);
      const n = await tx.appointment.updateMany({
        where: { id: a.id, clinicId: c.id, status: 'CONFIRMED', version: body.version },
        data: { doctorId: bctx.doctor.id, startAt, endAt, serviceDate: toDate(serviceDate), updatedByMemberId: ctx.memberId, version: { increment: 1 } },
      });
      if (n.count === 0) throw new AppError('VERSION_CONFLICT', undefined, { current: { version: a.version } });
      await tx.publicAccessToken.updateMany({ where: { clinicId: c.id, appointmentId: a.id, purpose: 'BOOKING', revokedAt: null }, data: { expiresAt: bookingLinkExpiry(startAt) } });
      await writeAudit(tx, req, now, {
        clinicId: c.id, action: 'appointment.rescheduled', entityType: 'appointment', entityId: a.id,
        changes: { from: { doctorId: a.doctorId, startAt: a.startAt.toISOString() }, to: { doctorId: bctx.doctor.id, startAt: startAt.toISOString() } },
      });
    }, TX));
    res.json(view(await load(req, a.id)));
  }));

  // AT-07 staff cancellation with reason.
  appointments.post('/:id/cancel', ...staffChain(deps, 'CAP-APT-06', 'write'), h(async (req, res) => {
    const body = parse(StaffCancelRequest, req.body);
    const ctx = req.clinic!;
    const a = await load(req, uuidParam(req, 'id'));
    const now = clock.now();
    await prisma.$transaction(async (tx) => {
      const n = await tx.appointment.updateMany({
        where: { id: a.id, clinicId: ctx.clinicId, status: 'CONFIRMED', version: body.version },
        data: { status: 'CANCELLED', cancelledAt: now, cancelledBy: 'STAFF', cancelReason: body.reason, updatedByMemberId: ctx.memberId, version: { increment: 1 } },
      });
      if (n.count === 0) throw new AppError(a.status === 'CONFIRMED' ? 'VERSION_CONFLICT' : 'INVALID_TRANSITION', undefined, { current: { version: a.version } });
      await tx.publicAccessToken.updateMany({ where: { clinicId: ctx.clinicId, appointmentId: a.id, purpose: 'BOOKING', revokedAt: null }, data: { expiresAt: bookingLinkExpiry(now) } });
      await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'appointment.cancelled', entityType: 'appointment', entityId: a.id, fromStatus: 'CONFIRMED', toStatus: 'CANCELLED', reason: body.reason });
    }, TX);
    res.json(view(await load(req, a.id)));
  }));

  // FR-APT-012 / AT-08 + QT-02: one transaction sets CHECKED_IN and allocates the token; UNIQUE (appointment_id) prevents a second entry.
  appointments.post('/:id/check-in', ...staffChain(deps, 'CAP-APT-07', 'write'), h(async (req, res) => {
    const body = parse(CheckInBody, req.body);
    const c = await loadClinic(req);
    const ctx = req.clinic!;
    const a = await load(req, uuidParam(req, 'id'));
    const now = clock.now();
    const out = await retryOnDeadlock(() => prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM appointment WHERE id = ${a.id}::uuid AND clinic_id = ${c.id}::uuid FOR UPDATE`;
      const cur = await tx.appointment.findFirstOrThrow({ where: { id: a.id, clinicId: c.id } });
      if (cur.status !== 'CONFIRMED') throw new AppError('INVALID_TRANSITION', 'Only confirmed appointments can be checked in.', { current: { version: cur.version } });
      if (body.version !== undefined && body.version !== cur.version) throw new AppError('VERSION_CONFLICT', undefined, { current: { version: cur.version } });
      if (fromDate(cur.serviceDate) !== clinicToday(now, c.timezone)) throw new AppError('INVALID_TRANSITION', 'Check-in is possible only on the appointment day.');
      const opens = cur.startAt.getTime() - c.checkinBeforeMin * 60_000;
      const closes = cur.startAt.getTime() + c.checkinAfterMin * 60_000;
      const inWindow = now.getTime() >= opens && now.getTime() <= closes;
      if (!inWindow && !body.overrideReason) throw new AppError('OVERRIDE_REASON_REQUIRED', 'Outside the check-in window; enter a reason to check in (A-019).');
      const sortTime = new Date(Math.max(now.getTime(), cur.startAt.getTime())); // BR-060 / A-012
      const { entry } = await allocateEntry(tx, c, now, { source: 'SCHEDULED', doctorId: cur.doctorId, serviceId: cur.serviceId, patientId: cur.patientId!, appointmentId: cur.id, sortTime, memberId: ctx.memberId });
      await tx.appointment.update({ where: { id: cur.id }, data: { status: 'CHECKED_IN', checkedInAt: now, checkInOverrideReason: inWindow ? null : body.overrideReason!, updatedByMemberId: ctx.memberId, version: { increment: 1 } } });
      await emitEvent(tx, { clinicId: c.id, type: 'appointment.updated', doctorId: cur.doctorId, appointmentId: cur.id, payload: { entityId: cur.id, status: 'CHECKED_IN' } });
      await writeAudit(tx, req, now, { clinicId: c.id, action: inWindow ? 'appointment.checked_in' : 'appointment.checked_in_override', entityType: 'appointment', entityId: cur.id, fromStatus: 'CONFIRMED', toStatus: 'CHECKED_IN', reason: inWindow ? null : body.overrideReason });
      return entry;
    }, TX));
    res.json({ appointment: view(await load(req, a.id)), queueEntry: { id: out.id, token: formatToken(out.tokenNumber), status: out.status } });
  }));

  // FR-APT-013 / AT-09: staff no-show only after the grace period.
  appointments.post('/:id/no-show', ...staffChain(deps, 'CAP-APT-08', 'write'), h(async (req, res) => {
    const body = parse(VersionBody, req.body);
    const c = await loadClinic(req);
    const a = await load(req, uuidParam(req, 'id'));
    const now = clock.now();
    if (a.status !== 'CONFIRMED') throw new AppError('INVALID_TRANSITION', 'Only confirmed appointments can be marked no-show.', { current: { version: a.version } });
    if (now.getTime() < a.startAt.getTime() + c.noShowGraceMin * 60_000) throw new AppError('INVALID_TRANSITION', 'The no-show grace period has not passed yet.');
    await prisma.$transaction(async (tx) => {
      const n = await tx.appointment.updateMany({ where: { id: a.id, clinicId: c.id, status: 'CONFIRMED', ...(body.version !== undefined ? { version: body.version } : {}) }, data: { status: 'NO_SHOW', noShowAt: now, updatedByMemberId: req.clinic!.memberId, version: { increment: 1 } } });
      if (n.count === 0) throw new AppError('VERSION_CONFLICT', undefined, { current: { version: a.version } });
      await emitEvent(tx, { clinicId: c.id, type: 'appointment.updated', doctorId: a.doctorId, appointmentId: a.id, payload: { entityId: a.id, status: 'NO_SHOW' } });
      await writeAudit(tx, req, now, { clinicId: c.id, action: 'appointment.no_show', entityType: 'appointment', entityId: a.id, fromStatus: 'CONFIRMED', toStatus: 'NO_SHOW' });
    });
    res.json(view(await load(req, a.id)));
  }));

  return { appointments, availability };
}
