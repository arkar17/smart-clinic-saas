import { Router, type Request } from 'express';
import { CreateDoctorRequest, ExceptionRequest, ScheduleQuery, UpdateDoctorRequest, WeekSchedule, dayToIntervals, fromMinutes, intervalsToWeek, toMinutes } from '@sc/contracts';
import { MAX_INTERVALS_PER_DAY } from '@sc/config';
import type { Prisma } from '../../generated/prisma/index.js';
import { fieldError, notFound } from '../../infra/errors';
import { fromDate, h, toDate, uuidParam } from '../../infra/http';
import { parse } from '../../infra/validate';
import { addDays } from '../../infra/time';
import type { Deps } from '../../infra/context';
import { writeAudit } from '../audit/index';
import { assertDoctorScope, grantOf, staffChain } from '../identity/index';
import { clinicIntervals, doctorIntervals, intersect, outsideClinicHours, toUtc, type Interval } from './availability';

export * from './availability';

const include = { availability: true, services: { select: { serviceId: true } } } as const;
type Row = Prisma.DoctorGetPayload<{ include: typeof include }>;

/** scheduling module (SC1-BE-10): doctor profiles, weekly availability, exceptions and schedule view. */
export function doctorRoutes(deps: Deps): Router {
  const r = Router();
  const { prisma, clock } = deps;
  const read = staffChain(deps, 'CAP-CLN-05', 'read');
  const write = staffChain(deps, 'CAP-CLN-05', 'write');

  const clinicHours = (clinicId: string) => prisma.clinicBusinessHour.findMany({ where: { clinicId } });
  const view = (d: Row, hours: { weekday: number; startMin: number; endMin: number }[]) => ({
    id: d.id, displayName: d.displayName, titleLabel: d.titleLabel, isActive: d.isActive, displayOrder: d.displayOrder, memberId: d.memberId,
    serviceIds: d.services.map((s) => s.serviceId),
    weekly: intervalsToWeek(d.availability),
    warnings: outsideClinicHours(d.availability, hours).map((w) => ({ code: 'OUTSIDE_CLINIC_HOURS', weekday: w.weekday, start: fromMinutes(w.start), end: fromMinutes(w.end) })),
  });
  const load = async (req: Request, id: string) => {
    assertDoctorScope(req, id);
    const d = await prisma.doctor.findFirst({ where: { id, clinicId: req.clinic!.clinicId }, include });
    if (!d) throw notFound();
    return d;
  };

  /** BR-082: link only to a membership of this clinic holding DOCTOR, not linked to another profile. */
  async function assertLinkable(clinicId: string, memberId: string, doctorId?: string) {
    const m = await prisma.clinicMember.findFirst({ where: { id: memberId, clinicId }, include: { doctor: { select: { id: true } } } });
    if (!m) throw fieldError('memberId', 'Membership not found in this clinic');
    if (!m.roles.includes('DOCTOR')) throw fieldError('memberId', 'The membership must hold the DOCTOR role');
    if (m.doctor && m.doctor.id !== doctorId) throw fieldError('memberId', 'This membership is already linked to another doctor profile');
  }

  r.get('/', ...read, h(async (req, res) => {
    const ctx = req.clinic!;
    const where: Prisma.DoctorWhereInput = { clinicId: ctx.clinicId };
    if (grantOf(req) === 'OWN') where.id = ctx.doctorId ?? '00000000-0000-0000-0000-000000000000'; // FR-DOC-005: own profile only
    const [rows, hours] = await Promise.all([prisma.doctor.findMany({ where, include, orderBy: [{ displayOrder: 'asc' }, { displayName: 'asc' }] }), clinicHours(ctx.clinicId)]);
    res.json({ items: rows.map((d) => view(d, hours)) });
  }));

  r.post('/', ...write, h(async (req, res) => {
    const body = parse(CreateDoctorRequest, req.body);
    const ctx = req.clinic!;
    const now = clock.now();
    if (body.memberId) await assertLinkable(ctx.clinicId, body.memberId);
    const d = await prisma.$transaction(async (tx) => {
      const d = await tx.doctor.create({ data: { ...body, clinicId: ctx.clinicId, createdAt: now } });
      await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'doctor.created', entityType: 'doctor', entityId: d.id, changes: body });
      return d;
    });
    res.status(201).json(view(await load(req, d.id), await clinicHours(ctx.clinicId)));
  }));

  r.patch('/:id', ...write, h(async (req, res) => {
    const body = parse(UpdateDoctorRequest, req.body);
    const ctx = req.clinic!;
    const id = uuidParam(req, 'id');
    const now = clock.now();
    await load(req, id);
    if (body.memberId) await assertLinkable(ctx.clinicId, body.memberId, id);
    await prisma.$transaction(async (tx) => {
      await tx.doctor.updateMany({ where: { id, clinicId: ctx.clinicId }, data: body });
      await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'doctor.updated', entityType: 'doctor', entityId: id, changes: body });
    });
    res.json(view(await load(req, id), await clinicHours(ctx.clinicId)));
  }));

  // FR-DOC-002 / BR-045: replace the weekly schedule (same structure as clinic hours).
  r.put('/:id/availability', ...write, h(async (req, res) => {
    const week = parse(WeekSchedule, req.body);
    const ctx = req.clinic!;
    const id = uuidParam(req, 'id');
    const now = clock.now();
    await load(req, id);
    const rows = week.days.flatMap((d) => dayToIntervals(d).map((i) => ({ clinicId: ctx.clinicId, doctorId: id, weekday: d.weekday, startMin: i.startMin, endMin: i.endMin, createdAt: now })));
    if (week.days.some((d) => dayToIntervals(d).length > MAX_INTERVALS_PER_DAY)) throw fieldError('days', 'At most 4 intervals per day');
    await prisma.$transaction(async (tx) => {
      await tx.doctorAvailability.deleteMany({ where: { clinicId: ctx.clinicId, doctorId: id } });
      await tx.doctorAvailability.createMany({ data: rows });
      await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'doctor.schedule_updated', entityType: 'doctor', entityId: id, changes: { intervals: rows.length } });
    });
    res.json(view(await load(req, id), await clinicHours(ctx.clinicId)));
  }));

  const exceptionView = (e: { id: string; exceptionDate: Date; kind: string; startMin: number | null; endMin: number | null; reason: string | null }) => ({
    id: e.id, exceptionDate: fromDate(e.exceptionDate), kind: e.kind,
    startTime: e.startMin === null ? null : fromMinutes(e.startMin), endTime: e.endMin === null ? null : fromMinutes(e.endMin), reason: e.reason,
  });

  r.get('/:id/exceptions', ...read, h(async (req, res) => {
    const d = await load(req, uuidParam(req, 'id'));
    const rows = await prisma.scheduleException.findMany({ where: { clinicId: d.clinicId, doctorId: d.id }, orderBy: { exceptionDate: 'asc' } });
    res.json({ items: rows.map(exceptionView) });
  }));
  r.post('/:id/exceptions', ...write, h(async (req, res) => {
    const body = parse(ExceptionRequest, req.body);
    const ctx = req.clinic!;
    const d = await load(req, uuidParam(req, 'id'));
    const now = clock.now();
    const e = await prisma.$transaction(async (tx) => {
      const e = await tx.scheduleException.create({
        data: {
          clinicId: ctx.clinicId, doctorId: d.id, exceptionDate: toDate(body.exceptionDate), kind: body.kind,
          startMin: body.startTime ? toMinutes(body.startTime) : null, endMin: body.endTime ? toMinutes(body.endTime) : null,
          reason: body.reason ?? null, createdByMemberId: ctx.memberId, createdAt: now,
        },
      });
      await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'doctor.exception_created', entityType: 'schedule_exception', entityId: e.id, changes: { ...body } });
      return e;
    });
    res.status(201).json(exceptionView(e));
  }));
  r.delete('/:id/exceptions/:exId', ...write, h(async (req, res) => {
    const ctx = req.clinic!;
    const d = await load(req, uuidParam(req, 'id'));
    const exId = uuidParam(req, 'exId');
    const now = clock.now();
    await prisma.$transaction(async (tx) => {
      const n = await tx.scheduleException.deleteMany({ where: { id: exId, clinicId: ctx.clinicId, doctorId: d.id } });
      if (n.count === 0) throw notFound();
      await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'doctor.exception_deleted', entityType: 'schedule_exception', entityId: exId });
    });
    res.status(204).end();
  }));

  // FR-DOC-005 / D-02: resolved intervals per date (appointments are added in SC-2).
  r.get('/:id/schedule', ...read, h(async (req, res) => {
    const q = parse(ScheduleQuery, req.query);
    const ctx = req.clinic!;
    const d = await load(req, uuidParam(req, 'id'));
    if (q.to < q.from || addDays(q.from, 62) < q.to) throw fieldError('to', 'Range must be 0–62 days');
    const [hours, closures, exceptions] = await Promise.all([
      clinicHours(ctx.clinicId),
      prisma.clinicClosure.findMany({ where: { clinicId: ctx.clinicId, startDate: { lte: toDate(q.to) }, endDate: { gte: toDate(q.from) } } }),
      prisma.scheduleException.findMany({ where: { clinicId: ctx.clinicId, doctorId: d.id, exceptionDate: { gte: toDate(q.from), lte: toDate(q.to) } } }),
    ]);
    const cl = closures.map((c) => ({ startDate: fromDate(c.startDate), endDate: fromDate(c.endDate), startMin: c.startMin, endMin: c.endMin }));
    const ex = exceptions.map((e) => ({ exceptionDate: fromDate(e.exceptionDate), kind: e.kind, startMin: e.startMin, endMin: e.endMin }));
    const fmt = (list: Interval[]) => list.map((i) => ({ start: fromMinutes(i.start), end: fromMinutes(i.end) }));
    const days = [];
    for (let date = q.from; date <= q.to; date = addDays(date, 1)) {
      const c = clinicIntervals(date, hours, cl);
      const dd = doctorIntervals(date, d.availability, ex);
      const bookable = intersect(c, dd);
      days.push({
        date, clinic: fmt(c), doctor: fmt(dd), bookable: fmt(bookable),
        bookableUtc: toUtc(date, bookable, ctx.timezone).map((i) => ({ start: i.start.toISOString(), end: i.end.toISOString() })),
        exceptions: exceptions.filter((e) => fromDate(e.exceptionDate) === date).map(exceptionView),
      });
    }
    res.json({ doctorId: d.id, timezone: ctx.timezone, days });
  }));

  return r;
}
