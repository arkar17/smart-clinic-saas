import { Router, type Request, type Response } from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import {
  AvailabilityDatesQuery, AvailabilitySlotsQuery, ConfirmRequest, EmptyRequest, HoldRequest, PublicServicesQuery, ReleaseRequest,
  firstName, fromMinutes, maskPhone, type PublicBooking, type PublicClinic, type PublicService, type WalkInState,
} from '@sc/contracts';
import type { Prisma } from '../../generated/prisma/index.js';
import { AppError, notFound } from '../../infra/errors';
import { fromDate, h, parseCookies, toDate, uuidParam } from '../../infra/http';
import { parse } from '../../infra/validate';
import { addDays, clinicToday } from '../../infra/time';
import { randomToken, safeEqual, sha256 } from '../../infra/crypto';
import { idempotent } from '../../infra/idempotency';
import type { Deps } from '../../infra/context';
import { writeAudit } from '../audit/index';
import { findOrCreatePatient, validatePatientIdentity } from '../patients/index';
import { clinicIntervals, type ClosureRow } from '../scheduling/index';
import { assertSlot, bookingContext, computeSlots, expireStaleHolds } from './slots';
import { bookingLinkExpiry, freshReference, issueBookingToken, privateBookingUrl } from './tokens';

export { assertSlot, bookingContext, computeSlots, expireStaleHolds, loadBusy } from './slots';
export { bookingLinkExpiry, freshReference, issueBookingToken, privateBookingUrl } from './tokens';
export { expireHolds, purgeIdempotency } from './jobs';

type Clinic = Prisma.ClinicGetPayload<object>;
const MAX_DATE_RANGE_DAYS = 92;
/** Arch 17: interactive transactions with a 5 s timeout; waiting for a pooled connection may take longer under bursts. */
export const TX = { maxWait: 10_000, timeout: 5_000 };
const MAX_HOLDS_PER_IP = 5; // Arch 9 / BR-054
const HOLD_COOKIE = 'sc_hold';

function limiterMiddleware(points: number, duration: number, message: string) {
  const limiter = new RateLimiterMemory({ points, duration });
  return h(async (req, _res, next) => {
    try {
      await limiter.consume(req.ctx.ipHash?.toString('hex') ?? 'unknown');
    } catch (e) {
      throw new AppError('RATE_LIMITED', message, { retryAfterSec: Math.ceil(((e as { msBeforeNext?: number }).msBeforeNext ?? 60_000) / 1000) });
    }
    next();
  });
}

/** Public clinic portal, booking discovery and reservations (FR-QR-004/005, FR-APT-001..008). No patient data in responses except the patient's own masked details. */
export function publicRoutes(deps: Deps): Router {
  const r = Router();
  const { prisma, clock } = deps;
  r.use(limiterMiddleware(deps.env.PUBLIC_RATE_LIMIT_PER_MIN, 60, 'Too many requests. Please wait.')); // FR-SEC-007
  const holdLimiter = limiterMiddleware(deps.env.HOLD_RATE_LIMIT_PER_MIN, 60, 'Too many reservation attempts. Please wait.');

  /** Clinic from :slug; only ACTIVE clinics are public (404 otherwise, identical body). */
  const loadClinic = async (req: Request) => {
    const c = await prisma.clinic.findFirst({ where: { slug: String(req.params.slug ?? ''), status: 'ACTIVE' } });
    if (!c) throw notFound();
    return c;
  };
  const closuresBetween = async (clinicId: string, from: string, to: string): Promise<ClosureRow[]> =>
    (await prisma.clinicClosure.findMany({ where: { clinicId, startDate: { lte: toDate(to) }, endDate: { gte: toDate(from) } } }))
      .map((c) => ({ startDate: fromDate(c.startDate), endDate: fromDate(c.endDate), startMin: c.startMin, endMin: c.endMin, label: c.label }));

  /** FR-APT-001 / FR-SVC-004: active, online-bookable services with ≥ 1 active eligible doctor. */
  async function bookableServices(clinicId: string): Promise<PublicService[]> {
    const rows = await prisma.clinicService.findMany({
      where: { clinicId, isActive: true, onlineBookingEnabled: true },
      include: { doctors: { where: { doctor: { isActive: true } }, include: { doctor: true } } },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });
    return rows
      .filter((s) => s.doctors.length > 0)
      .map((s) => {
        const doctors = s.doctors.map((d) => d.doctor).sort((a, b) => a.displayOrder - b.displayOrder || a.displayName.localeCompare(b.displayName))
          .map((d) => ({ id: d.id, displayName: d.displayName, titleLabel: d.titleLabel }));
        return { id: s.id, name: s.name, description: s.description, durationMin: s.durationMin, doctors, preselectedDoctorId: doctors.length === 1 ? doctors[0]!.id : null };
      });
  }

  r.get('/:slug', h(async (req, res) => {
    const c = await loadClinic(req);
    const now = clock.now();
    const today = clinicToday(now, c.timezone);
    const [hours, closures, services] = await Promise.all([
      prisma.clinicBusinessHour.findMany({ where: { clinicId: c.id } }),
      closuresBetween(c.id, today, today),
      bookableServices(c.id),
    ]);
    const intervals = clinicIntervals(today, hours, closures);
    const fullDay = closures.find((x) => x.startMin === null);
    const body: PublicClinic = {
      slug: c.slug, name: c.name, address: c.address, contactPhone: c.contactPhoneE164, timezone: c.timezone,
      today: { date: today, intervals: intervals.map((i) => ({ start: fromMinutes(i.start), end: fromMinutes(i.end) })), ...(intervals.length ? {} : { closedLabel: fullDay?.label ?? 'Closed today' }) },
      walkIn: walkInState(c, intervals, now),
      actions: {
        book: services.length ? { enabled: true } : { enabled: false, reason: 'No services are available for online booking at the moment.' },
        // Same-day queue registration is delivered in SC-3; until then the action is shown as coming soon.
        joinQueue: { enabled: false, reason: 'Joining the queue online is coming soon. Please ask at reception.' },
      },
    };
    res.json(body);
  }));

  r.get('/:slug/services', h(async (req, res) => {
    parse(PublicServicesQuery, req.query);
    const c = await loadClinic(req);
    res.json({ timezone: c.timezone, items: await bookableServices(c.id) });
  }));

  r.get('/:slug/availability/dates', h(async (req, res) => {
    const q = parse(AvailabilityDatesQuery, req.query);
    const c = await loadClinic(req);
    const now = clock.now();
    const today = clinicToday(now, c.timezone);
    const from = q.from ?? today;
    const to = q.to ?? addDays(today, c.horizonDays);
    if (to < from || addDays(from, MAX_DATE_RANGE_DAYS) < to) throw new AppError('VALIDATION_ERROR', undefined, { fields: { to: [`Range must be 0–${MAX_DATE_RANGE_DAYS} days`] } });
    const out = await computeSlots(prisma, c, await bookingContext(prisma, c.id, q.serviceId, q.doctorId, 'PUBLIC'), from, to, now, 'PUBLIC');
    res.json({ timezone: c.timezone, dates: [...out].filter(([, s]) => s.length).map(([d]) => d) });
  }));

  r.get('/:slug/availability/slots', h(async (req, res) => {
    const q = parse(AvailabilitySlotsQuery, req.query);
    const c = await loadClinic(req);
    const ctx = await bookingContext(prisma, c.id, q.serviceId, q.doctorId, 'PUBLIC');
    const out = await computeSlots(prisma, c, ctx, q.date, q.date, clock.now(), 'PUBLIC');
    const slots = (out.get(q.date) ?? []).map((s) => ({ startAt: s.toISOString(), endAt: new Date(s.getTime() + ctx.service.durationMin * 60_000).toISOString() }));
    res.json({ date: q.date, timezone: c.timezone, slots });
  }));

  // AT-01 hold (Arch 17.1).
  r.post('/:slug/reservations', holdLimiter, h(async (req, res) => {
    const body = parse(HoldRequest, req.body);
    const c = await loadClinic(req);
    const now = clock.now();
    const startAt = new Date(body.startAt);
    const ctx = await bookingContext(prisma, c.id, body.serviceId, body.doctorId, 'PUBLIC');
    const cookieRaw = parseCookies(req.headers.cookie)[HOLD_COOKIE];
    const clientRaw = cookieRaw && /^[A-Za-z0-9_-]{22}$/.test(cookieRaw) ? cookieRaw : randomToken(16);
    const clientHash = sha256(clientRaw);
    const ownHold = await prisma.appointment.findFirst({ where: { clinicId: c.id, holdClientHash: clientHash, status: 'PENDING' }, select: { id: true } });
    const { endAt, serviceDate } = await assertSlot(prisma, c, ctx, startAt, now, 'PUBLIC', ownHold ? [ownHold.id] : []);
    const out = await prisma.$transaction((tx) => idempotent(tx, req, { clinicId: c.id, endpoint: 'reservations.create', encKey: deps.env.IDEMPOTENCY_ENC_KEY, now }, async () => {
      await expireStaleHolds(tx, ctx.doctor.id, startAt, endAt, now);
      // AT-04: a new hold from the same browser replaces its previous one.
      await tx.appointment.updateMany({ where: { clinicId: c.id, holdClientHash: clientHash, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: now, cancelledBy: 'PATIENT', cancelReason: 'REPLACED_BY_NEW_HOLD', reservationSecretHash: null, holdIpHash: null, version: { increment: 1 } } });
      const active = await tx.appointment.count({ where: { clinicId: c.id, holdIpHash: req.ctx.ipHash, status: 'PENDING', holdExpiresAt: { gt: now } } });
      if (req.ctx.ipHash && active >= MAX_HOLDS_PER_IP) throw new AppError('RATE_LIMITED', 'Too many active reservations from this network.', { retryAfterSec: c.holdMinutes * 60 });
      const secret = randomToken(16); // BR-024: 128-bit, returned only to this browser
      const expiresAt = new Date(now.getTime() + c.holdMinutes * 60_000);
      const a = await tx.appointment.create({
        data: {
          clinicId: c.id, doctorId: ctx.doctor.id, serviceId: ctx.service.id, channel: 'PUBLIC', status: 'PENDING', serviceDate: toDate(serviceDate), startAt, endAt,
          reservationSecretHash: sha256(secret), holdExpiresAt: expiresAt, holdClientHash: clientHash, holdIpHash: req.ctx.ipHash, createdAt: now,
        },
      });
      await writeAudit(tx, req, now, { clinicId: c.id, actorType: 'PUBLIC_PATIENT', action: 'appointment.held', entityType: 'appointment', entityId: a.id, toStatus: 'PENDING' });
      return {
        status: 201,
        body: {
          reservationId: a.id, reservationSecret: secret, expiresAt: expiresAt.toISOString(),
          summary: { service: ctx.service.name, doctor: ctx.doctor.displayName, startAt: startAt.toISOString(), endAt: endAt.toISOString(), timezone: c.timezone },
        },
      };
    }), TX);
    if (!out.replayed) res.cookie(HOLD_COOKIE, clientRaw, { httpOnly: true, secure: deps.env.COOKIE_SECURE, sameSite: 'strict', path: '/api/public', maxAge: 3_600_000 });
    res.status(out.status).json(out.body);
  }));

  /** Locks the hold and checks the reservation secret (timing-safe). Unknown / wrong secret → 404. */
  async function lockHold(tx: Prisma.TransactionClient, clinicId: string, id: string, secret: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM appointment WHERE id = ${id}::uuid AND clinic_id = ${clinicId}::uuid FOR UPDATE`;
    if (!rows.length) throw notFound();
    const a = await tx.appointment.findFirstOrThrow({ where: { id, clinicId }, include: { service: true, doctor: true } });
    const stored = a.reservationSecretHash ? Buffer.from(a.reservationSecretHash).toString('hex') : '';
    if (a.status !== 'PENDING' || !safeEqual(stored, sha256(secret).toString('hex'))) throw notFound();
    return a;
  }

  // AT-02 confirm (Arch 17.2).
  r.post('/:slug/reservations/:id/confirm', h(async (req, res) => {
    const body = parse(ConfirmRequest, req.body);
    const c = await loadClinic(req);
    const id = uuidParam(req, 'id');
    const identity = validatePatientIdentity({ fullName: body.fullName, phone: body.phone }, c.defaultPhoneRegion); // 422 before anything changes
    const now = clock.now();
    const out = await prisma.$transaction(async (tx) => idempotent(tx, req, { clinicId: c.id, endpoint: 'reservations.confirm', encKey: deps.env.IDEMPOTENCY_ENC_KEY, now }, async () => {
      const a = await lockHold(tx, c.id, id, body.reservationSecret);
      if (!a.holdExpiresAt || a.holdExpiresAt <= now) throw new AppError('HOLD_EXPIRED', 'Your reservation has expired. Please choose a time again.');
      try {
        await assertSlot(tx, c, await bookingContext(tx, c.id, a.serviceId, a.doctorId, 'PUBLIC'), a.startAt, now, 'STAFF', [a.id]); // schedule changes since the hold (A-E3)
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        await tx.appointment.update({ where: { id: a.id }, data: { status: 'CANCELLED', cancelledAt: now, cancelledBy: 'SYSTEM', cancelReason: 'SLOT_NO_LONGER_VALID', reservationSecretHash: null, holdIpHash: null, version: { increment: 1 } } });
        return { status: 409, body: { error: { code: 'SLOT_UNAVAILABLE', message: 'This time is no longer available. Please choose another.', requestId: req.ctx.requestId } } };
      }
      // FR-APT-017 / BR-055: per-phone limit of active future appointments.
      const active = await tx.appointment.count({ where: { clinicId: c.id, status: 'CONFIRMED', startAt: { gt: now }, patient: { phoneE164: identity.phoneE164 } } });
      if (active >= c.maxActiveBookings) throw new AppError('BOOKING_LIMIT_REACHED', 'This phone number already has the maximum number of upcoming appointments.');
      const { patient } = await findOrCreatePatient(tx, c.id, identity, 'QR_BOOKING', now);
      const reference = await freshReference(tx, c.id);
      const n = await tx.appointment.updateMany({
        where: { id: a.id, clinicId: c.id, status: 'PENDING', version: a.version },
        data: { status: 'CONFIRMED', patientId: patient.id, bookingReference: reference, confirmedAt: now, reservationSecretHash: null, holdIpHash: null, holdExpiresAt: null, version: { increment: 1 } },
      });
      if (n.count === 0) throw new AppError('HOLD_EXPIRED', 'Your reservation has expired. Please choose a time again.');
      const token = await issueBookingToken(tx, c.id, a.id, a.startAt, now);
      await writeAudit(tx, req, now, { clinicId: c.id, actorType: 'PUBLIC_PATIENT', action: 'appointment.confirmed', entityType: 'appointment', entityId: a.id, fromStatus: 'PENDING', toStatus: 'CONFIRMED' });
      return {
        status: 201,
        body: {
          appointmentId: a.id, bookingReference: reference, status: 'CONFIRMED', startAt: a.startAt.toISOString(), endAt: a.endAt.toISOString(), timezone: c.timezone,
          service: a.service.name, doctor: a.doctor.displayName, privateUrl: privateBookingUrl(deps, c.slug, token),
        },
      };
    }), TX);
    res.status(out.status).json(out.body);
  }));

  // AT-04 release ("Change time").
  r.post('/:slug/reservations/:id/release', h(async (req, res) => {
    const body = parse(ReleaseRequest, req.body);
    const c = await loadClinic(req);
    const id = uuidParam(req, 'id');
    const now = clock.now();
    const out = await prisma.$transaction(async (tx) => idempotent(tx, req, { clinicId: c.id, endpoint: 'reservations.release', encKey: deps.env.IDEMPOTENCY_ENC_KEY, now }, async () => {
      const a = await lockHold(tx, c.id, id, body.reservationSecret);
      await tx.appointment.update({ where: { id: a.id }, data: { status: 'CANCELLED', cancelledAt: now, cancelledBy: 'PATIENT', cancelReason: 'RELEASED', reservationSecretHash: null, holdIpHash: null, version: { increment: 1 } } });
      await writeAudit(tx, req, now, { clinicId: c.id, actorType: 'PUBLIC_PATIENT', action: 'appointment.released', entityType: 'appointment', entityId: a.id, fromStatus: 'PENDING', toStatus: 'CANCELLED' });
      return { status: 200, body: { reservationId: a.id, status: 'CANCELLED' } };
    }), TX);
    res.status(out.status).json(out.body);
  }));

  return r;
}

/** Private booking link (FR-APT-008, FR-APT-009, Arch 12.3). Mounted at /api/public/booking; clinic and record come from the token only. */
export function privateBookingRoutes(deps: Deps): Router {
  const r = Router();
  const { prisma, clock } = deps;
  const failures = new RateLimiterMemory({ points: deps.env.TOKEN_FAILURE_LIMIT_PER_10_MIN, duration: 600 });

  async function resolve(req: Request, res: Response) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    const ipKey = req.ctx.ipHash?.toString('hex') ?? 'unknown';
    const blocked = await failures.get(ipKey);
    if (blocked && blocked.remainingPoints <= 0) throw new AppError('RATE_LIMITED', 'Too many attempts. Please wait.', { retryAfterSec: Math.ceil(blocked.msBeforeNext / 1000) });
    const raw = req.get('x-access-token') ?? '';
    const now = clock.now();
    const t = raw.length >= 32 && raw.length <= 64
      ? await prisma.publicAccessToken.findFirst({
          where: { tokenHash: sha256(raw), purpose: 'BOOKING', revokedAt: null, expiresAt: { gt: now } },
          include: { clinic: true, appointment: { include: { service: true, doctor: true, patient: true } } },
        })
      : null;
    if (!t || !t.appointment || !['ACTIVE', 'SUSPENDED'].includes(t.clinic.status)) {
      await failures.consume(ipKey).catch(() => undefined);
      throw notFound(); // generic: random, expired, revoked or other-clinic tokens look identical (TC-SEC-006)
    }
    if (!t.lastUsedAt || now.getTime() - t.lastUsedAt.getTime() >= 60_000) await prisma.publicAccessToken.update({ where: { id: t.id }, data: { lastUsedAt: now } });
    return { token: t, appointment: t.appointment, clinic: t.clinic, now };
  }

  const view = (x: Awaited<ReturnType<typeof resolve>>): PublicBooking => {
    const a = x.appointment;
    const cutoffAt = new Date(a.startAt.getTime() - x.clinic.cancelCutoffMin * 60_000);
    return {
      clinic: { name: x.clinic.name, slug: x.clinic.slug, contactPhone: x.clinic.contactPhoneE164, timezone: x.clinic.timezone, suspended: x.clinic.status === 'SUSPENDED' },
      service: { name: a.service.name, durationMin: a.service.durationMin },
      doctor: { displayName: a.doctor.displayName, titleLabel: a.doctor.titleLabel },
      startAt: a.startAt.toISOString(), endAt: a.endAt.toISOString(), status: a.status, bookingReference: a.bookingReference ?? '',
      patient: { firstName: firstName(a.patient?.fullName ?? ''), maskedPhone: a.patient?.phoneE164 ? maskPhone(a.patient.phoneE164) : '' }, // BR-033/034
      cancellation: { allowed: a.status === 'CONFIRMED' && x.clinic.status === 'ACTIVE' && x.now < cutoffAt, cutoffAt: cutoffAt.toISOString() },
    };
  };

  r.get('/', h(async (req, res) => res.json(view(await resolve(req, res)))));

  // AT-07 patient cancellation before the cutoff (BR-056).
  r.post('/cancel', h(async (req, res) => {
    parse(EmptyRequest, req.body);
    const x = await resolve(req, res);
    if (x.clinic.status !== 'ACTIVE') throw new AppError('CLINIC_READ_ONLY', 'This clinic is currently unavailable. Please contact the clinic.');
    const out = await prisma.$transaction((tx) => idempotent(tx, req, { clinicId: x.clinic.id, endpoint: 'booking.cancel', encKey: deps.env.IDEMPOTENCY_ENC_KEY, now: x.now }, async () => {
      const a = x.appointment;
      if (a.status !== 'CONFIRMED') throw new AppError('INVALID_TRANSITION', 'This appointment can no longer be cancelled.', { current: { version: a.version } });
      if (x.now >= new Date(a.startAt.getTime() - x.clinic.cancelCutoffMin * 60_000)) throw new AppError('CANCELLATION_CUTOFF_PASSED', 'It is too late to cancel online. Please call the clinic.');
      const n = await tx.appointment.updateMany({ where: { id: a.id, clinicId: x.clinic.id, status: 'CONFIRMED', version: a.version }, data: { status: 'CANCELLED', cancelledAt: x.now, cancelledBy: 'PATIENT', version: { increment: 1 } } });
      if (n.count === 0) throw new AppError('VERSION_CONFLICT');
      await tx.publicAccessToken.update({ where: { id: x.token.id }, data: { expiresAt: bookingLinkExpiry(x.now) } });
      await writeAudit(tx, req, x.now, { clinicId: x.clinic.id, actorType: 'PUBLIC_PATIENT', action: 'appointment.cancelled', entityType: 'appointment', entityId: a.id, fromStatus: 'CONFIRMED', toStatus: 'CANCELLED' });
      return { status: 200, body: { status: 'CANCELLED' } };
    }), TX);
    res.status(out.status).json(out.body);
  }));

  return r;
}

/** SRS 12.6 window: (first open + opens offset) … (last close − closes-before). FULL/PAUSED come with the SC-3 queue counter. */
export function walkInState(c: Clinic, intervals: { start: number; end: number }[], now: Date): PublicClinic['walkIn'] {
  if (!c.walkinEnabled) return { state: 'DISABLED' };
  const first = intervals[0], last = intervals[intervals.length - 1];
  if (!first || !last) return { state: 'CLOSED' };
  const opens = first.start + c.walkinOpensOffsetMin;
  const closes = last.end - c.walkinClosesBeforeMin;
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: c.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  const nowMin = Number(local.slice(0, 2)) * 60 + Number(local.slice(3, 5));
  const state: WalkInState = nowMin < opens ? 'NOT_YET_OPEN' : nowMin >= closes ? 'CLOSED' : 'OPEN';
  return { state, opensAt: fromMinutes(Math.max(0, opens)), closesAt: fromMinutes(Math.max(0, closes)) };
}
