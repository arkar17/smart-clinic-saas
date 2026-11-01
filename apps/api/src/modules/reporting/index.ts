import { Router } from 'express';
import { ReportRangeQuery, formatToken } from '@sc/contracts';
import { AppError } from '../../infra/errors';
import { fromDate, h, toDate } from '../../infra/http';
import { parse } from '../../infra/validate';
import { addDays, clinicToday } from '../../infra/time';
import type { Deps } from '../../infra/context';
import { grantOf, staffChain } from '../identity/index';
import { walkInEligibility } from '../queue/index';
import { rate, stats } from './metrics';

const QUEUE_STATES = ['REGISTERED', 'WAITING', 'CALLED', 'IN_CONSULTATION', 'COMPLETED'] as const;
const MAX_RANGE_DAYS = 90; // FR-RPT-002

/** reporting module (SC4-BE-01): Today snapshot and date-range summary (SRS 11.5). Aggregates only — no names or phones. */
export function reportRoutes(deps: Deps): Router {
  const r = Router();
  const { prisma, clock } = deps;

  // FR-RPT-001: Today dashboard; Doctor sees the own-doctor subset (CAP-RPT-01 ALLOW_OWN).
  r.get('/today', ...staffChain(deps, 'CAP-RPT-01', 'read'), h(async (req, res) => {
    const ctx = req.clinic!;
    const c = await prisma.clinic.findFirstOrThrow({ where: { id: ctx.clinicId } });
    const now = clock.now();
    const today = clinicToday(now, c.timezone);
    const date = toDate(today);
    const own = grantOf(req) === 'OWN';
    const doctorFilter = own ? { doctorId: ctx.doctorId ?? '00000000-0000-0000-0000-000000000000' } : {};
    const [appts, entries, doctors, walk, lastEvent] = await Promise.all([
      prisma.appointment.groupBy({ by: ['status'], where: { clinicId: c.id, serviceDate: date, status: { notIn: ['PENDING', 'EXPIRED'] }, ...doctorFilter }, _count: true }),
      prisma.queueEntry.findMany({ where: { clinicId: c.id, serviceDate: date, ...doctorFilter }, select: { doctorId: true, status: true, sortTime: true, tokenNumber: true } }),
      prisma.doctor.findMany({ where: { clinicId: c.id, isActive: true, ...(own ? { id: ctx.doctorId ?? undefined } : {}) }, orderBy: [{ displayOrder: 'asc' }, { displayName: 'asc' }], select: { id: true, displayName: true } }),
      walkInEligibility(prisma, c, now),
      prisma.clinicEvent.findFirst({ where: { clinicId: c.id }, orderBy: { id: 'desc' }, select: { id: true } }),
    ]);
    const waiting = entries.filter((e) => e.status === 'WAITING' && e.sortTime);
    const longest = waiting.length ? Math.max(...waiting.map((e) => now.getTime() - e.sortTime!.getTime())) : null;
    const used = walk.counter?.walkInCount ?? 0;
    res.json({
      date: today, timezone: c.timezone, clinicStatus: c.status, lastEventId: (lastEvent?.id ?? 0n).toString(),
      appointments: Object.fromEntries(appts.map((a) => [a.status, a._count])),
      queue: doctors.map((d) => ({
        doctorId: d.id, doctor: d.displayName,
        ...Object.fromEntries(QUEUE_STATES.map((s) => [s, entries.filter((e) => e.doctorId === d.id && e.status === s).length])),
        current: entries.filter((e) => e.doctorId === d.id && (e.status === 'CALLED' || e.status === 'IN_CONSULTATION')).map((e) => formatToken(e.tokenNumber))[0] ?? null,
      })),
      totals: Object.fromEntries(QUEUE_STATES.map((s) => [s, entries.filter((e) => e.status === s).length])),
      longestWaitMin: longest === null ? null : Math.round(longest / 60_000),
      walkIn: own ? null : { state: walk.state, used, capacity: c.walkinDailyCapacity, remaining: c.walkinDailyCapacity === null ? null : Math.max(0, c.walkinDailyCapacity - used), paused: walk.counter?.walkInPaused ?? false },
      activeDoctors: doctors.length,
    });
  }));

  /** FR-RPT-002..004, -006: aggregates for [from, to] in clinic-local dates (service_date is stored clinic-local). */
  async function summary(clinicId: string, from: string, to: string, now: Date) {
    if (to < from || addDays(from, MAX_RANGE_DAYS - 1) < to) throw new AppError('VALIDATION_ERROR', undefined, { fields: { to: [`Range must be 1–${MAX_RANGE_DAYS} days`] } });
    const c = await prisma.clinic.findFirstOrThrow({ where: { id: clinicId } });
    const range = { gte: toDate(from), lte: toDate(to) };
    const [entries, appts] = await Promise.all([
      prisma.queueEntry.findMany({ where: { clinicId, serviceDate: range }, include: { doctor: { select: { displayName: true } }, service: { select: { name: true } } } }),
      prisma.appointment.findMany({ where: { clinicId, serviceDate: range, confirmedAt: { not: null } }, select: { status: true, cancelledBy: true, checkedInAt: true, serviceDate: true } }),
    ]);
    const completed = entries.filter((e) => e.status === 'COMPLETED');
    const tally = (key: (e: (typeof entries)[number]) => string) => {
      const m: Record<string, number> = {};
      for (const e of completed) m[key(e)] = (m[key(e)] ?? 0) + 1;
      return m;
    };
    // SRS 11.5: waiting = first called − sort_time; consultation = completed − started; both exclude auto_closed.
    const waitMs = (list: typeof entries) => list.filter((e) => !e.autoClosed && e.firstCalledAt && e.sortTime).map((e) => e.firstCalledAt!.getTime() - e.sortTime!.getTime());
    const consultMs = (list: typeof entries) => list.filter((e) => e.status === 'COMPLETED' && !e.autoClosed && e.startedAt && e.completedAt).map((e) => e.completedAt!.getTime() - e.startedAt!.getTime());
    const doctors = [...new Map(entries.map((e) => [e.doctorId, e.doctor.displayName])).entries()];
    // Cancellation rate excludes abandoned holds (never confirmed: filtered above) and AT-11 cascades (checked in).
    const cancelled = appts.filter((a) => a.status === 'CANCELLED' && !a.checkedInAt);
    const today = clinicToday(now, c.timezone);
    const pastConfirmed = appts.filter((a) => fromDate(a.serviceDate) < today);
    const noShows = appts.filter((a) => a.status === 'NO_SHOW');
    const qrCreated = entries.filter((e) => e.source === 'QR_WALK_IN');
    const expired = entries.filter((e) => e.status === 'EXPIRED');
    return {
      clinic: c.name, timezone: c.timezone, from, to,
      completedVisits: {
        total: completed.length,
        byDay: tally((e) => fromDate(e.serviceDate)),
        bySource: tally((e) => e.source),
        byDoctor: tally((e) => e.doctor.displayName),
        byService: tally((e) => e.service.name),
      },
      waitingTime: { overall: stats(waitMs(entries)), byDoctor: Object.fromEntries(doctors.map(([id, name]) => [name, stats(waitMs(entries.filter((e) => e.doctorId === id)))])) },
      consultationDuration: { overall: stats(consultMs(entries)), byDoctor: Object.fromEntries(doctors.map(([id, name]) => [name, stats(consultMs(entries.filter((e) => e.doctorId === id)))])) },
      appointments: {
        confirmed: appts.length,
        cancelledByPatient: cancelled.filter((a) => a.cancelledBy === 'PATIENT').length,
        cancelledByStaff: cancelled.filter((a) => a.cancelledBy === 'STAFF').length,
        cancellationRate: rate(cancelled.length, appts.length),
        noShows: noShows.length,
        noShowRate: rate(noShows.length, pastConfirmed.length),
      },
      queue: {
        qrRegistrations: qrCreated.length,
        expiredRegistrations: expired.length,
        expiredRegistrationRate: rate(expired.length, qrCreated.length),
        noShows: entries.filter((e) => e.status === 'NO_SHOW').length,
        cancellations: entries.filter((e) => e.status === 'CANCELLED').length,
      },
    };
  }

  r.get('/summary', ...staffChain(deps, 'CAP-RPT-02', 'read'), h(async (req, res) => {
    const q = parse(ReportRangeQuery, req.query);
    res.json(await summary(req.clinic!.clinicId, q.from, q.to, clock.now()));
  }));

  // FR-RPT-005 (SHOULD): aggregate CSV only — no patient names or phone numbers.
  r.get('/summary.csv', ...staffChain(deps, 'CAP-RPT-02', 'read'), h(async (req, res) => {
    const q = parse(ReportRangeQuery, req.query);
    const s = await summary(req.clinic!.clinicId, q.from, q.to, clock.now());
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows: unknown[][] = [['section', 'key', 'value']];
    for (const [group, m] of Object.entries(s.completedVisits)) {
      if (typeof m === 'number') rows.push(['completed_visits', 'total', m]);
      else for (const [k, v] of Object.entries(m)) rows.push([`completed_visits_${group}`, k, v]);
    }
    for (const [k, v] of Object.entries(s.waitingTime.overall)) rows.push(['waiting_time_overall', k, v]);
    for (const [k, v] of Object.entries(s.consultationDuration.overall)) rows.push(['consultation_overall', k, v]);
    for (const [k, v] of Object.entries(s.appointments)) rows.push(['appointments', k, v]);
    for (const [k, v] of Object.entries(s.queue)) rows.push(['queue', k, v]);
    res.setHeader('Content-Disposition', `attachment; filename="report-${q.from}-${q.to}.csv"`);
    res.type('text/csv').send(rows.map((r) => r.map(esc).join(',')).join('\n'));
  }));

  return r;
}
