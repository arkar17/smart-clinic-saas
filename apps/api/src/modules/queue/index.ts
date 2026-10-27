import { Router, type Request, type Response } from 'express';
import {
  OptionalReasonVersionBody, PublicWalkInRequest, QueueTodayQuery, ReassignBody, ReasonVersionBody, StaffWalkInRequest, VersionBody, EmptyRequest,
  formatToken, type QueueAction,
} from '@sc/contracts';
import type { CapabilityId } from '@sc/contracts';
import type { Prisma } from '../../generated/prisma/index.js';
import { AppError, notFound } from '../../infra/errors';
import { fromDate, h, toDate, uuidParam } from '../../infra/http';
import { parse } from '../../infra/validate';
import { clinicToday } from '../../infra/time';
import { idempotent } from '../../infra/idempotency';
import { rateLimit } from '../../infra/ratelimit';
import { TX, retryOnDeadlock } from '../../infra/db';
import type { Deps } from '../../infra/context';
import { writeAudit } from '../audit/index';
import { grantOf, staffChain } from '../identity/index';
import { findOrCreatePatient, validatePatientIdentity } from '../patients/index';
import { emitEvent } from '../realtime/index';
import {
  REASON_TEXT, allocateEntry, assertServiceDoctor, counterOf, doctorRemainingToday, publicQueueStatus, resolveQueueAccess, transitionEntry, walkInEligibility, walkInServices,
} from './core';

export { allocateEntry, closeDays, publicQueueStatus, walkInEligibility, walkInServices, REASON_TEXT } from './core';

const publicUrl = (deps: Deps, slug: string, raw: string) => `${deps.env.PUBLIC_BASE_URL ?? deps.env.APP_ORIGIN}/c/${slug}/q/${raw}`;

/** Journey B public endpoints (FR-QUE-001..005, -014, -015, -018), mounted at /api/public. */
export function publicQueueRoutes(deps: Deps): Router {
  const r = Router();
  const { prisma, clock } = deps;
  const limit = rateLimit(deps.env.PUBLIC_RATE_LIMIT_PER_MIN, 60, 'Too many requests. Please wait.');
  const registerLimit = rateLimit(deps.env.HOLD_RATE_LIMIT_PER_MIN, 60, 'Too many registration attempts. Please wait.');
  r.use(limit);
  const loadClinic = async (req: Request) => {
    const c = await prisma.clinic.findFirst({ where: { slug: String(req.params.slug ?? ''), status: 'ACTIVE' } });
    if (!c) throw notFound();
    return c;
  };

  r.get('/clinics/:slug/walk-in/eligibility', h(async (req, res) => {
    const c = await loadClinic(req);
    const now = clock.now();
    const el = await walkInEligibility(prisma, c, now);
    const services = el.eligible ? await walkInServices(prisma, c, now) : [];
    const reason = el.eligible && !services.length ? 'NO_SERVICE' : el.reason;
    res.json({ eligible: !reason, reason, reasonText: reason ? REASON_TEXT[reason] : undefined, opensAt: el.opensAt, closesAt: el.closesAt, timezone: c.timezone, services });
  }));

  // QT-01: QR walk-in → REGISTERED with a private status link (registration does not prove arrival).
  r.post('/clinics/:slug/walk-ins', registerLimit, h(async (req, res) => {
    const body = parse(PublicWalkInRequest, req.body);
    const c = await loadClinic(req);
    const identity = validatePatientIdentity({ fullName: body.fullName, phone: body.phone }, c.defaultPhoneRegion); // BR-037: no bypass
    const now = clock.now();
    const { service, doctor } = await assertServiceDoctor(prisma, c.id, body.serviceId, body.doctorId, true);
    const out = await retryOnDeadlock(() => prisma.$transaction((tx) => idempotent(tx, req, { clinicId: c.id, endpoint: 'walk-ins.create', encKey: deps.env.IDEMPOTENCY_ENC_KEY, now }, async () => {
      const { patient } = await findOrCreatePatient(tx, c.id, identity, 'QR_WALK_IN', now);
      const { entry, rawToken } = await allocateEntry(tx, c, now, { source: 'QR_WALK_IN', doctorId: doctor.id, serviceId: service.id, patientId: patient.id, phoneE164: identity.phoneE164 });
      await writeAudit(tx, req, now, { clinicId: c.id, actorType: 'PUBLIC_PATIENT', action: 'queue.registered', entityType: 'queue_entry', entityId: entry.id, toStatus: 'REGISTERED' });
      return {
        status: 201,
        body: { queueEntryId: entry.id, token: formatToken(entry.tokenNumber), status: entry.status, doctor: doctor.displayName, service: service.name, timezone: c.timezone, privateUrl: publicUrl(deps, c.slug, rawToken!) },
      };
    }), TX));
    res.status(out.status).json(out.body);
  }));

  const access = async (req: Request, res: Response) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    const a = await resolveQueueAccess(prisma, req.get('x-access-token') ?? '', clock.now());
    if (!a) throw notFound(); // generic for random, expired, revoked and other-clinic tokens
    return a;
  };

  r.get('/queue-entry', h(async (req, res) => res.json(await publicQueueStatus(prisma, (await access(req, res)).entryId))));

  // FR-QUE-015 (SHOULD) / QT-04 / QT-07: patient leaves while REGISTERED or WAITING.
  r.post('/queue-entry/leave', h(async (req, res) => {
    parse(EmptyRequest, req.body);
    const a = await access(req, res);
    if (a.clinic.status !== 'ACTIVE') throw new AppError('CLINIC_READ_ONLY', 'This clinic is currently unavailable. Please contact the clinic.');
    const now = clock.now();
    const out = await prisma.$transaction((tx) => idempotent(tx, req, { clinicId: a.clinic.id, endpoint: 'queue.leave', encKey: deps.env.IDEMPOTENCY_ENC_KEY, now }, async () => {
      await transitionEntry(tx, a.clinic.id, a.entryId, 'CANCEL', now, { actor: 'PATIENT', reason: 'LEFT_QUEUE' });
      await writeAudit(tx, req, now, { clinicId: a.clinic.id, actorType: 'PUBLIC_PATIENT', action: 'queue.left', entityType: 'queue_entry', entityId: a.entryId, toStatus: 'CANCELLED' });
      return { status: 200, body: await publicQueueStatus(tx, a.entryId) };
    }), TX);
    res.status(out.status).json(out.body);
  }));

  // FR-QUE-013: the patient's own status stream; every frame is recomputed for this entry only.
  r.get('/stream', h(async (req, res) => {
    const a = await access(req, res);
    const raw = req.get('x-access-token') ?? '';
    const subId = deps.hub!.open({
      kind: 'public', clinicId: a.clinic.id, entryId: a.entryId, ipKey: req.ctx.ipHash?.toString('hex') ?? 'unknown', res,
      status: () => publicQueueStatus(prisma, a.entryId),
      revalidate: async () => (await resolveQueueAccess(prisma, raw, clock.now()))?.entryId === a.entryId,
    });
    if (subId === null) throw new AppError('RATE_LIMITED', 'Too many open status pages from this network.', { retryAfterSec: 30 });
    deps.hub!.send(subId, 'status', await publicQueueStatus(prisma, a.entryId));
  }));

  return r;
}

/** Reception and doctor queue operations (FR-QUE-006..012, -019, FR-CLN-007), mounted at /api/queue. */
export function staffQueueRoutes(deps: Deps): { queue: Router; pause: Router; stream: Router } {
  const { prisma, clock } = deps;
  const queue = Router();
  const pause = Router();
  const stream = Router();
  const loadClinic = (req: Request) => prisma.clinic.findFirstOrThrow({ where: { id: req.clinic!.clinicId } });
  const entryView = (e: Prisma.QueueEntryGetPayload<{ include: { patient: true; doctor: true; service: true } }>) => ({
    id: e.id, token: formatToken(e.tokenNumber), tokenNumber: e.tokenNumber, status: e.status, source: e.source, doctorId: e.doctorId, doctor: e.doctor.displayName,
    service: e.service.name, serviceId: e.serviceId, appointmentId: e.appointmentId, patient: { id: e.patient.id, fullName: e.patient.fullName, phone: e.patient.phoneE164 },
    registeredAt: e.registeredAt, arrivedAt: e.arrivedAt, sortTime: e.sortTime, recallCount: e.recallCount, endReason: e.endReason, version: e.version,
  });

  // GET /api/queue/today (CAP-QUE-04 clinic-wide / CAP-QUE-05 doctor queue; DR sees own doctor only).
  queue.get('/today', ...staffChain(deps, 'CAP-QUE-05', 'read'), h(async (req, res) => {
    const q = parse(QueueTodayQuery, req.query);
    const ctx = req.clinic!;
    const c = await loadClinic(req);
    const today = clinicToday(clock.now(), c.timezone);
    let doctorId = q.doctorId;
    if (grantOf(req) === 'OWN' || !ctx.roles.some((r) => r === 'CLINIC_ADMIN' || r === 'RECEPTIONIST')) {
      if (!ctx.doctorId || (q.doctorId && q.doctorId !== ctx.doctorId)) throw notFound();
      doctorId = ctx.doctorId;
    }
    const [lastEvent, counter, entries] = await Promise.all([
      prisma.clinicEvent.findFirst({ where: { clinicId: c.id }, orderBy: { id: 'desc' }, select: { id: true } }),
      counterOf(prisma, c.id, today),
      prisma.queueEntry.findMany({ where: { clinicId: c.id, serviceDate: toDate(today), doctorId }, include: { patient: true, doctor: true, service: true }, orderBy: [{ sortTime: { sort: 'asc', nulls: 'last' } }, { tokenNumber: 'asc' }] }),
    ]);
    res.json({
      date: today, timezone: c.timezone, lastEventId: (lastEvent?.id ?? 0n).toString(),
      counter: { lastToken: counter?.lastToken ?? 0, walkInCount: counter?.walkInCount ?? 0, capacity: c.walkinDailyCapacity, paused: counter?.walkInPaused ?? false },
      entries: entries.map(entryView),
    });
  }));

  // FR-QUE-006 / QT-02: staff walk-in directly WAITING; over capacity only with a reason (A-014).
  queue.post('/walk-ins', ...staffChain(deps, 'CAP-QUE-02', 'write'), h(async (req, res) => {
    const body = parse(StaffWalkInRequest, req.body);
    const c = await loadClinic(req);
    const ctx = req.clinic!;
    const identity = validatePatientIdentity({ fullName: body.fullName, phone: body.phone }, c.defaultPhoneRegion);
    const now = clock.now();
    const { service, doctor } = await assertServiceDoctor(prisma, c.id, body.serviceId, body.doctorId, false);
    if (!(await doctorRemainingToday(prisma, c, doctor.id, now))) throw new AppError('DOCTOR_NOT_ELIGIBLE', 'This doctor is not available for the rest of today.');
    const entry = await retryOnDeadlock(() => prisma.$transaction(async (tx) => {
      const { patient } = await findOrCreatePatient(tx, c.id, identity, 'STAFF', now);
      const { entry } = await allocateEntry(tx, c, now, { source: 'STAFF_WALK_IN', doctorId: doctor.id, serviceId: service.id, patientId: patient.id, overrideReason: body.overrideReason ?? null, memberId: ctx.memberId });
      await writeAudit(tx, req, now, { clinicId: c.id, action: body.overrideReason ? 'queue.walk_in_capacity_override' : 'queue.walk_in_created', entityType: 'queue_entry', entityId: entry.id, toStatus: 'WAITING', reason: body.overrideReason ?? null });
      return entry;
    }, TX));
    const full = await prisma.queueEntry.findFirstOrThrow({ where: { id: entry.id }, include: { patient: true, doctor: true, service: true } });
    res.status(201).json({ queueEntry: entryView(full), privateUrl: null });
  }));

  /** Loads the entry in the selected clinic; DR (OWN) only for their own doctor profile → 404 otherwise. */
  const scoped = async (req: Request) => {
    const e = await prisma.queueEntry.findFirst({ where: { id: uuidParam(req, 'id'), clinicId: req.clinic!.clinicId } });
    if (!e || (grantOf(req) === 'OWN' && e.doctorId !== req.clinic!.doctorId)) throw notFound();
    return e;
  };
  const transition = (action: QueueAction, cap: CapabilityId, schema: typeof VersionBody | typeof ReasonVersionBody | typeof OptionalReasonVersionBody) =>
    [...staffChain(deps, cap, 'write'), h(async (req: Request, res: Response) => {
      const body = parse(schema, req.body) as { version?: number; reason?: string };
      const e = await scoped(req);
      const now = clock.now();
      const own = grantOf(req) === 'OWN' ? req.clinic!.doctorId : null;
      const out = await retryOnDeadlock(() => prisma.$transaction(async (tx) => {
        const r = await transitionEntry(tx, req.clinic!.clinicId, e.id, action, now, { version: body.version, reason: body.reason ?? null, actor: 'STAFF', expectDoctorId: own });
        await writeAudit(tx, req, now, { clinicId: req.clinic!.clinicId, action: `queue.${action.toLowerCase()}`, entityType: 'queue_entry', entityId: e.id, fromStatus: r.before.status, toStatus: r.after.status, reason: body.reason ?? null });
        return r.after;
      }, TX));
      const full = await prisma.queueEntry.findFirstOrThrow({ where: { id: out.id }, include: { patient: true, doctor: true, service: true } });
      res.json({ queueEntry: entryView(full) });
    })];

  queue.post('/entries/:id/confirm-arrival', ...transition('CONFIRM_ARRIVAL', 'CAP-QUE-03', VersionBody));
  queue.post('/entries/:id/call', ...transition('CALL', 'CAP-QUE-06', ReasonVersionBody)); // out of order with reason (SHOULD)
  queue.post('/entries/:id/start', ...transition('START', 'CAP-QUE-07', VersionBody));
  queue.post('/entries/:id/complete', ...transition('COMPLETE', 'CAP-QUE-07', VersionBody));
  queue.post('/entries/:id/return-to-waiting', ...transition('RETURN_TO_WAITING', 'CAP-QUE-08', VersionBody));
  queue.post('/entries/:id/no-show', ...transition('NO_SHOW', 'CAP-QUE-08', OptionalReasonVersionBody));
  queue.post('/entries/:id/cancel', ...transition('CANCEL', 'CAP-QUE-09', ReasonVersionBody));

  // FR-QUE-019 (SHOULD) / QT-08: reassign a WAITING entry; token and sort time kept.
  queue.post('/entries/:id/reassign', ...staffChain(deps, 'CAP-QUE-10', 'write'), h(async (req, res) => {
    const body = parse(ReassignBody, req.body);
    const e = await scoped(req);
    const c = await loadClinic(req);
    const now = clock.now();
    await assertServiceDoctor(prisma, c.id, e.serviceId, body.doctorId, false);
    if (!(await doctorRemainingToday(prisma, c, body.doctorId, now))) throw new AppError('DOCTOR_NOT_ELIGIBLE', 'This doctor is not available for the rest of today.');
    await prisma.$transaction(async (tx) => {
      const r = await transitionEntry(tx, c.id, e.id, 'REASSIGN', now, { version: body.version, actor: 'STAFF', newDoctorId: body.doctorId });
      await writeAudit(tx, req, now, { clinicId: c.id, action: 'queue.reassigned', entityType: 'queue_entry', entityId: e.id, changes: { fromDoctorId: r.before.doctorId, toDoctorId: body.doctorId } });
    }, TX);
    const full = await prisma.queueEntry.findFirstOrThrow({ where: { id: e.id }, include: { patient: true, doctor: true, service: true } });
    res.json({ queueEntry: entryView(full) });
  }));

  // FR-QUE-009 / QT-06: head of the doctor's line (ORDER BY sort_time, token) locked with SKIP LOCKED.
  queue.post('/doctors/:doctorId/call-next', ...staffChain(deps, 'CAP-QUE-06', 'write'), h(async (req, res) => {
    parse(EmptyRequest, req.body);
    const ctx = req.clinic!;
    const doctorId = uuidParam(req, 'doctorId');
    if (grantOf(req) === 'OWN' && doctorId !== ctx.doctorId) throw notFound();
    const c = await loadClinic(req);
    if (!(await prisma.doctor.findFirst({ where: { id: doctorId, clinicId: c.id } }))) throw notFound();
    const now = clock.now();
    const today = toDate(clinicToday(now, c.timezone));
    const called = await retryOnDeadlock(() => prisma.$transaction(async (tx) => {
      if (await tx.queueEntry.count({ where: { doctorId, status: { in: ['CALLED', 'IN_CONSULTATION'] } } })) throw new AppError('DOCTOR_BUSY', 'This doctor already has a patient called or in consultation.');
      const [head] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM queue_entry WHERE clinic_id = ${c.id}::uuid AND doctor_id = ${doctorId}::uuid AND service_date = ${today} AND status = 'WAITING'
        ORDER BY sort_time, token_number FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!head) return null;
      const r = await transitionEntry(tx, c.id, head.id, 'CALL', now, { actor: 'STAFF', expectDoctorId: doctorId });
      await writeAudit(tx, req, now, { clinicId: c.id, action: 'queue.call', entityType: 'queue_entry', entityId: head.id, fromStatus: 'WAITING', toStatus: 'CALLED' });
      return r.after;
    }, TX));
    if (!called) return res.status(204).end();
    const full = await prisma.queueEntry.findFirstOrThrow({ where: { id: called.id }, include: { patient: true, doctor: true, service: true } });
    res.json({ queueEntry: entryView(full) });
  }));

  // FR-CLN-007 (SHOULD): pause/resume QR walk-in registration for today; a new day has a new counter row.
  const setPause = (paused: boolean) => [...staffChain(deps, 'CAP-CLN-03', 'write'), h(async (req: Request, res: Response) => {
    const c = await loadClinic(req);
    const now = clock.now();
    const date = toDate(clinicToday(now, c.timezone));
    const row = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO queue_counter (clinic_id, service_date, created_at, updated_at) VALUES (${c.id}::uuid, ${date}, ${now}, ${now}) ON CONFLICT DO NOTHING`;
      const row = await tx.queueCounter.update({ where: { clinicId_serviceDate: { clinicId: c.id, serviceDate: date } }, data: { walkInPaused: paused, pausedAt: paused ? now : null, pausedByMemberId: paused ? req.clinic!.memberId : null } });
      await writeAudit(tx, req, now, { clinicId: c.id, action: paused ? 'queue.walk_in_paused' : 'queue.walk_in_resumed', entityType: 'clinic', entityId: c.id });
      await emitEvent(tx, { clinicId: c.id, type: 'queue.counter.updated', payload: { counters: { lastToken: row.lastToken, walkInCount: row.walkInCount, paused } } });
      return row;
    });
    res.json({ date: fromDate(row.serviceDate), paused: row.walkInPaused });
  })];
  pause.put('/', ...setPause(true));
  pause.delete('/', ...setPause(false));

  // FR-QUE-013: staff stream bound to the selected membership at connect; replay after Last-Event-ID.
  stream.get('/', ...staffChain(deps, 'CAP-QUE-05', 'read'), h(async (req, res) => {
    const ctx = req.clinic!;
    const p = req.principal!;
    const own = !ctx.roles.some((r) => r === 'CLINIC_ADMIN' || r === 'RECEPTIONIST');
    if (own && !ctx.doctorId) throw notFound();
    const sessionHash = p.sessionIdHash.toString('hex');
    const subId = deps.hub!.open({
      kind: 'staff', clinicId: ctx.clinicId, sessionHash, memberId: ctx.memberId, userId: p.userId, ownDoctorId: own ? ctx.doctorId : null,
      ipKey: req.ctx.ipHash?.toString('hex') ?? 'unknown', res,
      revalidate: async () => {
        // Arch 19.3: same checks as requireSession + requireClinic, for the membership bound at connect.
        const s = await prisma.session.findFirst({ where: { idHash: p.sessionIdHash }, include: { user: true, activeMembership: { include: { clinic: true } } } });
        const now = clock.now();
        const m = s?.activeMembership;
        if (!s || s.revokedAt || s.idleExpiresAt <= now || s.absoluteExpiresAt <= now || !s.user.isActive || !m || m.id !== ctx.memberId || !m.isActive) return false;
        return m.clinic.status !== 'SUSPENDED' || m.roles.includes('CLINIC_ADMIN');
      },
    });
    if (subId === null) throw new AppError('RATE_LIMITED', 'Too many open live screens.', { retryAfterSec: 30 });
    const last = req.get('last-event-id');
    if (last && /^\d+$/.test(last)) await deps.hub!.replay(subId, ctx.clinicId, BigInt(last));
  }));

  return { queue, pause, stream };
}
