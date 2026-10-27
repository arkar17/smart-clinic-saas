import { DateTime } from 'luxon';
import { RECALL_LIMIT, formatToken, queueTransition, type PublicQueueStatus, type QueueAction, type WalkInIneligibleReason, type WalkInState } from '@sc/contracts';
import { fromMinutes } from '@sc/contracts';
import type { Prisma, PrismaClient, QueueEntry, QueueSource } from '../../generated/prisma/index.js';
import { AppError, notFound } from '../../infra/errors';
import { fromDate, toDate } from '../../infra/http';
import { clinicToday } from '../../infra/time';
import { randomToken, sha256 } from '../../infra/crypto';
import { bookableIntervals, clinicIntervals, type ClosureRow, type ExceptionRow } from '../scheduling/index';
import { emitEvent } from '../realtime/index';

type Db = PrismaClient | Prisma.TransactionClient;
type Clinic = Prisma.ClinicGetPayload<object>;
const ACTIVE_STATUSES = ['REGISTERED', 'WAITING', 'CALLED', 'IN_CONSULTATION'] as const;
const CAPACITY_RELEASE_MS = 10 * 60_000; // A-014

async function dayRules(db: Db, clinicId: string, date: string) {
  const [hours, closures] = await Promise.all([
    db.clinicBusinessHour.findMany({ where: { clinicId } }),
    db.clinicClosure.findMany({ where: { clinicId, startDate: { lte: toDate(date) }, endDate: { gte: toDate(date) } } }),
  ]);
  const cl: ClosureRow[] = closures.map((c) => ({ startDate: fromDate(c.startDate), endDate: fromDate(c.endDate), startMin: c.startMin, endMin: c.endMin }));
  return { hours, closures: cl };
}

export const counterOf = (db: Db, clinicId: string, date: string) => db.queueCounter.findFirst({ where: { clinicId, serviceDate: toDate(date) } });

const localMinutes = (now: Date, zone: string) => {
  const d = DateTime.fromJSDate(now, { zone });
  return d.hour * 60 + d.minute + d.second / 60;
};

/** SRS 12.6 clinic-level walk-in eligibility (window, enabled, not paused, capacity). */
export async function walkInEligibility(db: Db, c: Clinic, now: Date) {
  const today = clinicToday(now, c.timezone);
  const { hours, closures } = await dayRules(db, c.id, today);
  const intervals = clinicIntervals(today, hours, closures);
  const counter = await counterOf(db, c.id, today);
  const first = intervals[0], last = intervals[intervals.length - 1];
  const opens = first ? first.start + c.walkinOpensOffsetMin : 0;
  const closes = last ? last.end - c.walkinClosesBeforeMin : 0;
  const window = first ? { opensAt: fromMinutes(Math.max(0, opens)), closesAt: fromMinutes(Math.max(0, closes)) } : {};
  const fail = (state: WalkInState, reason: WalkInIneligibleReason) => ({ eligible: false as const, state, reason, today, intervals, counter, ...window });
  if (!c.walkinEnabled || c.status !== 'ACTIVE') return fail('DISABLED', 'DISABLED');
  if (!first || !last) return fail('CLOSED', 'CLOSED_TODAY');
  const nowMin = localMinutes(now, c.timezone);
  if (nowMin < opens) return fail('NOT_YET_OPEN', 'NOT_YET_OPEN');
  if (nowMin >= closes) return fail('CLOSED', 'AFTER_CUTOFF'); // registration allowed during breaks (A-016)
  if (counter?.walkInPaused) return fail('PAUSED', 'PAUSED');
  if (c.walkinDailyCapacity !== null && (counter?.walkInCount ?? 0) >= c.walkinDailyCapacity) return fail('FULL', 'FULL');
  return { eligible: true as const, state: 'OPEN' as WalkInState, reason: undefined, today, intervals, counter, ...window };
}

export const REASON_TEXT: Record<WalkInIneligibleReason, string> = {
  DISABLED: 'Online queue registration is not offered by this clinic.',
  CLOSED_TODAY: 'The clinic is closed today.',
  NOT_YET_OPEN: 'Queue registration has not opened yet today.',
  AFTER_CUTOFF: 'Queue registration has closed for today.',
  PAUSED: 'Queue registration is paused at the moment. Please ask at reception.',
  FULL: 'Today’s walk-in places are full.',
  NO_SERVICE: 'No services are available for walk-in at the moment.',
};

/** FR-QUE-002: doctor has remaining working time today (now < end of the last bookable interval). */
export async function doctorRemainingToday(db: Db, c: Clinic, doctorId: string, now: Date) {
  const today = clinicToday(now, c.timezone);
  const { hours, closures } = await dayRules(db, c.id, today);
  const [availability, exceptions] = await Promise.all([
    db.doctorAvailability.findMany({ where: { clinicId: c.id, doctorId } }),
    db.scheduleException.findMany({ where: { clinicId: c.id, doctorId, exceptionDate: toDate(today) } }),
  ]);
  const ex: ExceptionRow[] = exceptions.map((e) => ({ exceptionDate: today, kind: e.kind, startMin: e.startMin, endMin: e.endMin }));
  const free = bookableIntervals({ date: today, zone: c.timezone, clinicHours: hours, closures, availability, exceptions: ex });
  return free.some((f) => f.end > now);
}

/** FR-QUE-002: active walk-in services with active eligible doctors who still work today; a single doctor is preselected. */
export async function walkInServices(db: Db, c: Clinic, now: Date) {
  const rows = await db.clinicService.findMany({
    where: { clinicId: c.id, isActive: true, walkInEnabled: true },
    include: { doctors: { where: { doctor: { isActive: true } }, include: { doctor: true } } },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
  });
  const out = [];
  for (const s of rows) {
    const doctors = [];
    for (const d of s.doctors.map((x) => x.doctor).sort((a, b) => a.displayOrder - b.displayOrder || a.displayName.localeCompare(b.displayName))) {
      if (await doctorRemainingToday(db, c, d.id, now)) doctors.push({ id: d.id, displayName: d.displayName, titleLabel: d.titleLabel });
    }
    if (doctors.length) out.push({ id: s.id, name: s.name, description: s.description, durationMin: s.durationMin, doctors, preselectedDoctorId: doctors.length === 1 ? doctors[0]!.id : null });
  }
  return out;
}

/** Service active + doctor active and eligible in this clinic (foreign IDs → 404). */
export async function assertServiceDoctor(db: Db, clinicId: string, serviceId: string, doctorId: string, walkIn: boolean) {
  const [service, doctor] = await Promise.all([
    db.clinicService.findFirst({ where: { id: serviceId, clinicId } }),
    db.doctor.findFirst({ where: { id: doctorId, clinicId }, include: { services: { where: { serviceId } } } }),
  ]);
  if (!service || !doctor) throw notFound();
  if (!service.isActive || (walkIn && !service.walkInEnabled)) throw new AppError('SERVICE_NOT_BOOKABLE', 'This service is not available for walk-in.');
  if (!doctor.isActive || doctor.services.length === 0) throw new AppError('DOCTOR_NOT_ELIGIBLE', 'This doctor is not available for this service.');
  return { service, doctor };
}

/** BR-023 / A-023: queue links remain valid until 24 h after the close of their service day. */
export function queueLinkExpiry(c: Clinic, serviceDate: string) {
  return DateTime.fromISO(serviceDate, { zone: c.timezone }).plus({ days: 2 }).startOf('day').toUTC().toJSDate();
}

/**
 * Arch 18 allocateEntry: the counter row lock serialises the clinic-day; the increment and the insert share the
 * transaction, so tokens are gapless and unique (FR-QUE-004, ADR-008, ADR-009).
 */
export async function allocateEntry(tx: Prisma.TransactionClient, c: Clinic, now: Date, input: {
  source: QueueSource; doctorId: string; serviceId: string; patientId: string; phoneE164?: string | null; appointmentId?: string | null;
  overrideReason?: string | null; sortTime?: Date; memberId?: string | null;
}) {
  const today = clinicToday(now, c.timezone);
  const date = toDate(today);
  await tx.$executeRaw`INSERT INTO queue_counter (clinic_id, service_date, created_at, updated_at) VALUES (${c.id}::uuid, ${date}, ${now}, ${now}) ON CONFLICT DO NOTHING`;
  const [counter] = await tx.$queryRaw<{ last_token: number; walk_in_count: number; walk_in_paused: boolean }[]>`
    SELECT last_token, walk_in_count, walk_in_paused FROM queue_counter WHERE clinic_id = ${c.id}::uuid AND service_date = ${date} FOR UPDATE`;
  const walkIn = input.source !== 'SCHEDULED';
  if (input.source === 'QR_WALK_IN') {
    const el = await walkInEligibility(tx, c, now); // re-checked under the lock (FR-QUE-001)
    if (!el.eligible) throw el.reason === 'FULL' ? new AppError('CAPACITY_REACHED', REASON_TEXT.FULL) : new AppError('REGISTRATION_CLOSED', REASON_TEXT[el.reason], { details: { reason: el.reason } });
    if (!(await doctorRemainingToday(tx, c, input.doctorId, now))) throw new AppError('DOCTOR_NOT_ELIGIBLE', 'This doctor is not available for the rest of today.');
    const dup = await tx.$queryRaw<{ n: number }[]>`
      SELECT 1 AS n FROM queue_entry qe JOIN patient p ON p.clinic_id = qe.clinic_id AND p.id = qe.patient_id
      WHERE qe.clinic_id = ${c.id}::uuid AND qe.service_date = ${date} AND p.phone_e164 = ${input.phoneE164 ?? ''}
        AND qe.status IN ('REGISTERED', 'WAITING', 'CALLED', 'IN_CONSULTATION') LIMIT 1`;
    if (dup.length) throw new AppError('DUPLICATE_ACTIVE_REGISTRATION', 'This phone number is already in today’s queue. Please ask at reception.');
  }
  if (walkIn && c.walkinDailyCapacity !== null && counter!.walk_in_count >= c.walkinDailyCapacity) {
    if (input.source === 'QR_WALK_IN') throw new AppError('CAPACITY_REACHED', REASON_TEXT.FULL);
    if (!input.overrideReason) throw new AppError('OVERRIDE_REASON_REQUIRED', 'Daily walk-in capacity is reached; enter a reason to add this patient.');
  }
  const [row] = await tx.$queryRaw<{ last_token: number; walk_in_count: number; walk_in_paused: boolean }[]>`
    UPDATE queue_counter SET last_token = last_token + 1, walk_in_count = walk_in_count + ${walkIn ? 1 : 0}, updated_at = ${now}
    WHERE clinic_id = ${c.id}::uuid AND service_date = ${date} RETURNING last_token, walk_in_count, walk_in_paused`;
  const qr = input.source === 'QR_WALK_IN';
  const entry = await tx.queueEntry.create({
    data: {
      clinicId: c.id, serviceDate: date, tokenNumber: row!.last_token, doctorId: input.doctorId, serviceId: input.serviceId, patientId: input.patientId,
      appointmentId: input.appointmentId ?? null, source: input.source, status: qr ? 'REGISTERED' : 'WAITING', countsTowardCapacity: walkIn,
      capacityOverrideReason: input.overrideReason ?? null, registeredAt: now, arrivedAt: qr ? null : now, sortTime: qr ? null : (input.sortTime ?? now),
      createdByMemberId: input.memberId ?? null, createdAt: now,
    },
  });
  let rawToken: string | null = null;
  if (qr) {
    rawToken = randomToken(32);
    await tx.publicAccessToken.create({ data: { clinicId: c.id, purpose: 'QUEUE', tokenHash: sha256(rawToken), queueEntryId: entry.id, expiresAt: queueLinkExpiry(c, today), createdAt: now } });
  }
  await emitEvent(tx, { clinicId: c.id, type: 'queue.entry.created', doctorId: entry.doctorId, queueEntryId: entry.id, payload: { entityId: entry.id, status: entry.status, token: entry.tokenNumber, version: entry.version } });
  await emitEvent(tx, { clinicId: c.id, type: 'queue.counter.updated', payload: { counters: { lastToken: row!.last_token, walkInCount: row!.walk_in_count, paused: row!.walk_in_paused } } });
  return { entry, rawToken };
}

/** AT-10 / AT-11: a SCHEDULED entry's terminal status is mirrored on its CHECKED_IN appointment. */
async function syncAppointment(tx: Prisma.TransactionClient, entry: QueueEntry, to: string, now: Date, reason: string | null, actor: 'PATIENT' | 'STAFF' | 'SYSTEM') {
  if (!entry.appointmentId) return;
  const data: Prisma.AppointmentUpdateManyMutationInput =
    to === 'COMPLETED' ? { status: 'COMPLETED', completedAt: now } : { status: 'CANCELLED', cancelledAt: now, cancelledBy: actor, cancelReason: reason ?? to };
  const n = await tx.appointment.updateMany({ where: { id: entry.appointmentId, clinicId: entry.clinicId, status: 'CHECKED_IN' }, data: { ...data, version: { increment: 1 } } });
  if (n.count) await emitEvent(tx, { clinicId: entry.clinicId, type: 'appointment.updated', doctorId: entry.doctorId, appointmentId: entry.appointmentId, payload: { entityId: entry.appointmentId, status: String(data.status) } });
}

/**
 * Applies one QT transition on a locked row (ADR-016 layers 1–2; the trigger is layer 3). `expectDoctorId` re-checks
 * the doctor scope under the lock so a concurrent reassignment cannot be acted on (TC-QUE-023).
 */
export async function transitionEntry(tx: Prisma.TransactionClient, clinicId: string, entryId: string, action: QueueAction, now: Date, opts: {
  version?: number; reason?: string | null; actor: 'PATIENT' | 'STAFF'; expectDoctorId?: string | null; newDoctorId?: string;
}) {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM queue_entry WHERE id = ${entryId}::uuid AND clinic_id = ${clinicId}::uuid FOR UPDATE`;
  if (!locked.length) throw notFound();
  const e = await tx.queueEntry.findFirstOrThrow({ where: { id: entryId, clinicId } });
  if (opts.expectDoctorId && e.doctorId !== opts.expectDoctorId) throw notFound();
  if (opts.version !== undefined && opts.version !== e.version) throw new AppError('VERSION_CONFLICT', undefined, { current: { version: e.version } });
  const to = queueTransition(e.status, action, { recallCount: e.recallCount });
  if (to === 'RECALL_LIMIT') throw new AppError('RECALL_LIMIT_REACHED', `A patient can be returned to waiting at most ${RECALL_LIMIT} times.`);
  if (!to) throw new AppError('INVALID_TRANSITION', `Not possible while ${e.status.toLowerCase().replace('_', ' ')}.`, { current: { version: e.version } });
  if (action === 'CONFIRM_ARRIVAL' && fromDate(e.serviceDate) !== clinicToday(now, (await tx.clinic.findFirstOrThrow({ where: { id: clinicId } })).timezone)) {
    throw new AppError('INVALID_TRANSITION', 'Arrival can be confirmed only on the queue day.');
  }
  const data: Prisma.QueueEntryUncheckedUpdateInput = { status: to, version: { increment: 1 } };
  if (action === 'CONFIRM_ARRIVAL') Object.assign(data, { arrivedAt: now, sortTime: now }); // QT-03, BR-060
  if (action === 'CALL') Object.assign(data, { firstCalledAt: e.firstCalledAt ?? now, lastCalledAt: now });
  if (action === 'START') data.startedAt = now;
  if (action === 'COMPLETE') Object.assign(data, { completedAt: now, endedAt: now });
  if (action === 'RETURN_TO_WAITING') data.recallCount = { increment: 1 }; // original sort time kept (QT-10)
  if (action === 'NO_SHOW' || action === 'CANCEL') Object.assign(data, { endedAt: now, endReason: opts.reason ?? null, cancelledBy: action === 'CANCEL' ? opts.actor : 'STAFF' });
  if (action === 'REASSIGN') data.doctorId = opts.newDoctorId!; // composite FK keeps the doctor inside the clinic
  let updated: QueueEntry;
  try {
    updated = await tx.queueEntry.update({ where: { id: e.id }, data });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002' || /queue_entry_doctor_busy/.test(String(err))) throw new AppError('DOCTOR_BUSY', 'This doctor already has a patient called or in consultation.');
    throw err;
  }
  // BR-062 / A-014: a patient cancelling a walk-in within 10 minutes releases its capacity.
  if (action === 'CANCEL' && opts.actor === 'PATIENT' && e.countsTowardCapacity && now.getTime() - e.registeredAt.getTime() < CAPACITY_RELEASE_MS) {
    await tx.$executeRaw`SELECT 1 FROM queue_counter WHERE clinic_id = ${clinicId}::uuid AND service_date = ${e.serviceDate} FOR UPDATE`;
    await tx.queueEntry.update({ where: { id: e.id }, data: { countsTowardCapacity: false } });
    const [c] = await tx.$queryRaw<{ last_token: number; walk_in_count: number; walk_in_paused: boolean }[]>`
      UPDATE queue_counter SET walk_in_count = GREATEST(walk_in_count - 1, 0), updated_at = ${now} WHERE clinic_id = ${clinicId}::uuid AND service_date = ${e.serviceDate}
      RETURNING last_token, walk_in_count, walk_in_paused`;
    await emitEvent(tx, { clinicId, type: 'queue.counter.updated', payload: { counters: { lastToken: c!.last_token, walkInCount: c!.walk_in_count, paused: c!.walk_in_paused } } });
  }
  if (to === 'COMPLETED' || to === 'CANCELLED' || to === 'NO_SHOW') await syncAppointment(tx, e, to, now, opts.reason ?? null, action === 'CANCEL' ? opts.actor : 'STAFF');
  await emitEvent(tx, { clinicId, type: 'queue.entry.updated', doctorId: updated.doctorId, queueEntryId: e.id, payload: { entityId: e.id, status: updated.status, token: updated.tokenNumber, version: updated.version } });
  if (action === 'REASSIGN') await emitEvent(tx, { clinicId, type: 'queue.entry.updated', doctorId: e.doctorId, queueEntryId: e.id, payload: { entityId: e.id, status: updated.status, token: updated.tokenNumber, version: updated.version } });
  return { before: e, after: updated };
}

const STATUS_TEXT: Record<string, string> = {
  REGISTERED: 'Registered — please confirm your arrival at reception',
  WAITING: 'Waiting', CALLED: 'Please go to the doctor now', IN_CONSULTATION: 'In consultation',
  COMPLETED: 'Visit completed', CANCELLED: 'Cancelled', NO_SHOW: 'Marked as not present', EXPIRED: 'Registration expired',
};

/** FR-QUE-014 / BR-061: own token, status, doctor, now-serving token and people ahead (WAITING only). */
export async function publicQueueStatus(db: Db, entryId: string): Promise<PublicQueueStatus> {
  const e = await db.queueEntry.findFirstOrThrow({ where: { id: entryId }, include: { doctor: true, clinic: true } });
  const sameDoctor = { clinicId: e.clinicId, serviceDate: e.serviceDate, doctorId: e.doctorId };
  const [serving, ahead] = await Promise.all([
    db.queueEntry.findMany({ where: { ...sameDoctor, status: { in: ['IN_CONSULTATION', 'CALLED'] } }, select: { status: true, tokenNumber: true } }),
    e.status === 'WAITING' && e.sortTime
      ? db.queueEntry.count({ where: { ...sameDoctor, status: 'WAITING', OR: [{ sortTime: { lt: e.sortTime } }, { sortTime: e.sortTime, tokenNumber: { lt: e.tokenNumber } }] } })
      : Promise.resolve(0),
  ]);
  const now = serving.find((s) => s.status === 'IN_CONSULTATION') ?? serving.find((s) => s.status === 'CALLED');
  return {
    token: formatToken(e.tokenNumber), status: e.status, statusText: STATUS_TEXT[e.status] ?? e.status, doctor: e.doctor.displayName,
    clinic: { name: e.clinic.name, slug: e.clinic.slug, timezone: e.clinic.timezone },
    nowServingToken: now ? formatToken(now.tokenNumber) : null,
    peopleAhead: e.status === 'WAITING' ? ahead + (serving.some((s) => s.status === 'CALLED') ? 1 : 0) : null,
    canLeave: e.status === 'REGISTERED' || e.status === 'WAITING',
  };
}

/** QUEUE tokens bind one entry; scheduled patients use their BOOKING token once checked in (Arch 12.3). */
export async function resolveQueueAccess(db: Db, raw: string, now: Date) {
  if (raw.length < 32 || raw.length > 64) return null;
  const t = await db.publicAccessToken.findFirst({
    where: { tokenHash: sha256(raw), purpose: { in: ['QUEUE', 'BOOKING'] }, revokedAt: null, expiresAt: { gt: now } },
    include: { clinic: true, appointment: { include: { queueEntry: true } } },
  });
  if (!t || !['ACTIVE', 'SUSPENDED'].includes(t.clinic.status)) return null;
  const entryId = t.queueEntryId ?? t.appointment?.queueEntry?.id;
  return entryId ? { token: t, clinic: t.clinic, entryId } : null;
}

/**
 * Day close (FR-QUE-016, FR-APT-013, ADR-030): finalise records whose service date is before the clinic-local today.
 * Idempotent conditional updates; safe to run concurrently or repeatedly (TC-NFR-004).
 */
export async function closeDays(prisma: PrismaClient, now: Date) {
  const clinics = await prisma.clinic.findMany({ where: { status: { in: ['ACTIVE', 'SUSPENDED'] } }, select: { id: true, timezone: true } });
  let changed = 0;
  for (const c of clinics) {
    const d = toDate(clinicToday(now, c.timezone));
    changed += await prisma.$transaction(async (tx) => {
      let n = 0;
      n += await tx.$executeRaw`UPDATE queue_entry SET status = 'EXPIRED', ended_at = ${now}, end_reason = 'SYSTEM_DAY_CLOSE', version = version + 1
        WHERE clinic_id = ${c.id}::uuid AND service_date < ${d} AND status = 'REGISTERED'`;
      n += await tx.$executeRaw`UPDATE queue_entry SET status = 'CANCELLED', ended_at = ${now}, cancelled_by = 'SYSTEM', end_reason = 'SYSTEM_DAY_CLOSE', version = version + 1
        WHERE clinic_id = ${c.id}::uuid AND service_date < ${d} AND status IN ('WAITING', 'CALLED')`;
      n += await tx.$executeRaw`UPDATE queue_entry SET status = 'COMPLETED', completed_at = ${now}, ended_at = ${now}, auto_closed = true, version = version + 1
        WHERE clinic_id = ${c.id}::uuid AND service_date < ${d} AND status = 'IN_CONSULTATION'`;
      // AT-10 / AT-11 for checked-in appointments of closed days.
      n += await tx.$executeRaw`UPDATE appointment a SET status = 'COMPLETED', completed_at = ${now}, version = a.version + 1 FROM queue_entry q
        WHERE q.appointment_id = a.id AND a.clinic_id = ${c.id}::uuid AND a.status = 'CHECKED_IN' AND q.status = 'COMPLETED'`;
      n += await tx.$executeRaw`UPDATE appointment a SET status = 'CANCELLED', cancelled_at = ${now}, cancelled_by = 'SYSTEM', cancel_reason = COALESCE(q.end_reason, q.status::text), version = a.version + 1 FROM queue_entry q
        WHERE q.appointment_id = a.id AND a.clinic_id = ${c.id}::uuid AND a.status = 'CHECKED_IN' AND q.status IN ('CANCELLED', 'NO_SHOW')`;
      // A-021: unchecked-in CONFIRMED appointments become NO_SHOW.
      n += await tx.$executeRaw`UPDATE appointment SET status = 'NO_SHOW', no_show_at = ${now}, version = version + 1
        WHERE clinic_id = ${c.id}::uuid AND service_date < ${d} AND status = 'CONFIRMED'`;
      if (n) await emitEvent(tx, { clinicId: c.id, type: 'queue.counter.updated', payload: {} });
      return n;
    });
  }
  return changed;
}

export const ACTIVE_QUEUE_STATUSES = ACTIVE_STATUSES;
