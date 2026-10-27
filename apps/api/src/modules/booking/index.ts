import { Router, type Request } from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { AvailabilityDatesQuery, AvailabilitySlotsQuery, PublicServicesQuery, fromMinutes, type PublicClinic, type PublicService, type WalkInState } from '@sc/contracts';
import type { Prisma } from '../../generated/prisma/index.js';
import { AppError, notFound } from '../../infra/errors';
import { fromDate, h, toDate } from '../../infra/http';
import { parse } from '../../infra/validate';
import { addDays, clinicToday } from '../../infra/time';
import type { Deps } from '../../infra/context';
import { bookableIntervals, clinicIntervals, slotStarts, type ClosureRow, type ExceptionRow, type UtcInterval } from '../scheduling/index';

type Clinic = Prisma.ClinicGetPayload<object>;
const MAX_DATE_RANGE_DAYS = 92;

/** Public clinic portal and booking discovery (FR-QR-004/005, FR-APT-001..004). Read-only; no patient data. */
export function publicRoutes(deps: Deps): Router {
  const r = Router();
  const { prisma, clock } = deps;
  const limiter = new RateLimiterMemory({ points: deps.env.PUBLIC_RATE_LIMIT_PER_MIN, duration: 60 }); // FR-SEC-007

  r.use(h(async (req, _res, next) => {
    try {
      await limiter.consume(req.ctx.ipHash?.toString('hex') ?? 'unknown');
    } catch (e) {
      throw new AppError('RATE_LIMITED', 'Too many requests. Please wait.', { retryAfterSec: Math.ceil(((e as { msBeforeNext?: number }).msBeforeNext ?? 60_000) / 1000) });
    }
    next();
  }));

  /** Clinic from :slug; only ACTIVE clinics are public (404 otherwise, identical body). */
  const loadClinic = async (req: Request) => {
    const c = await prisma.clinic.findFirst({ where: { slug: String(req.params.slug ?? ''), status: 'ACTIVE' } });
    if (!c) throw notFound();
    return c;
  };
  const closuresBetween = async (clinicId: string, from: string, to: string): Promise<ClosureRow[]> =>
    (await prisma.clinicClosure.findMany({ where: { clinicId, startDate: { lte: toDate(to) }, endDate: { gte: toDate(from) } } }))
      .map((c) => ({ startDate: fromDate(c.startDate), endDate: fromDate(c.endDate), startMin: c.startMin, endMin: c.endMin, label: c.label }));

  /** FR-APT-001: active, online-bookable services with ≥ 1 active eligible doctor. */
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

  /** Validates service/doctor for public booking (SRS 12.4 first step). Foreign IDs → 404. */
  async function bookingContext(clinic: Clinic, serviceId: string, doctorId: string) {
    const [service, doctor] = await Promise.all([
      prisma.clinicService.findFirst({ where: { id: serviceId, clinicId: clinic.id } }),
      prisma.doctor.findFirst({ where: { id: doctorId, clinicId: clinic.id }, include: { availability: true, services: { where: { serviceId } } } }),
    ]);
    if (!service || !doctor) throw notFound();
    if (!service.isActive || !service.onlineBookingEnabled) throw new AppError('SERVICE_NOT_BOOKABLE', 'This service cannot be booked online.');
    if (!doctor.isActive || doctor.services.length === 0) throw new AppError('DOCTOR_NOT_ELIGIBLE', 'This doctor is not available for this service.');
    return { service, doctor };
  }

  /** Loads data once for [from, to] and returns slot starts per date (Arch 16, PUBLIC mode). */
  async function slotsForRange(clinic: Clinic, serviceId: string, doctorId: string, from: string, to: string) {
    const { service, doctor } = await bookingContext(clinic, serviceId, doctorId);
    const now = clock.now();
    const today = clinicToday(now, clinic.timezone);
    const lastDay = addDays(today, clinic.horizonDays);
    const start = from < today ? today : from;
    const end = to > lastDay ? lastDay : to;
    const out = new Map<string, Date[]>();
    if (end < start) return { out, service };
    const [hours, closures, exceptions] = await Promise.all([
      prisma.clinicBusinessHour.findMany({ where: { clinicId: clinic.id } }),
      closuresBetween(clinic.id, start, end),
      prisma.scheduleException.findMany({ where: { clinicId: clinic.id, doctorId, exceptionDate: { gte: toDate(start), lte: toDate(end) } } }),
    ]);
    const ex: ExceptionRow[] = exceptions.map((e) => ({ exceptionDate: fromDate(e.exceptionDate), kind: e.kind, startMin: e.startMin, endMin: e.endMin }));
    const busy: UtcInterval[] = []; // existing PENDING/CONFIRMED/CHECKED_IN/COMPLETED appointments are subtracted once SC-2B adds them
    const notBefore = new Date(now.getTime() + clinic.minNoticeMin * 60_000); // BR-052
    for (let date = start; date <= end; date = addDays(date, 1)) {
      const free = bookableIntervals({ date, zone: clinic.timezone, clinicHours: hours, closures, availability: doctor.availability, exceptions: ex });
      out.set(date, slotStarts(free, service.durationMin, clinic.slotGranularityMin, busy, notBefore));
    }
    return { out, service };
  }

  r.get('/:slug/availability/dates', h(async (req, res) => {
    const q = parse(AvailabilityDatesQuery, req.query);
    const c = await loadClinic(req);
    const today = clinicToday(clock.now(), c.timezone);
    const from = q.from ?? today;
    const to = q.to ?? addDays(today, c.horizonDays);
    if (to < from || addDays(from, MAX_DATE_RANGE_DAYS) < to) throw new AppError('VALIDATION_ERROR', undefined, { fields: { to: [`Range must be 0–${MAX_DATE_RANGE_DAYS} days`] } });
    const { out } = await slotsForRange(c, q.serviceId, q.doctorId, from, to);
    res.json({ timezone: c.timezone, dates: [...out].filter(([, s]) => s.length).map(([d]) => d) });
  }));

  r.get('/:slug/availability/slots', h(async (req, res) => {
    const q = parse(AvailabilitySlotsQuery, req.query);
    const c = await loadClinic(req);
    const { out, service } = await slotsForRange(c, q.serviceId, q.doctorId, q.date, q.date);
    const slots = (out.get(q.date) ?? []).map((s) => ({ startAt: s.toISOString(), endAt: new Date(s.getTime() + service.durationMin * 60_000).toISOString() }));
    res.json({ date: q.date, timezone: c.timezone, slots });
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
