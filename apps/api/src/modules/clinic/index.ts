import { Router } from 'express';
import QRCode from 'qrcode';
import {
  ClosureRequest, CreateServiceRequest, ServiceDoctorsRequest, UpdateProfileRequest, UpdateServiceRequest, UpdateSettingsRequest, WeekSchedule,
  dayToIntervals, intervalsToWeek, toMinutes,
} from '@sc/contracts';
import type { Prisma } from '../../generated/prisma/index.js';
import { AppError, fieldError, notFound } from '../../infra/errors';
import { fromDate, h, ifMatchVersion, toDate, uuidParam } from '../../infra/http';
import { parse } from '../../infra/validate';
import type { Deps } from '../../infra/context';
import { writeAudit } from '../audit/index';
import { staffChain } from '../identity/index';

type Clinic = Prisma.ClinicGetPayload<object>;
const profileView = (c: Clinic) => ({
  id: c.id, name: c.name, slug: c.slug, address: c.address, contactPhone: c.contactPhoneE164, timezone: c.timezone, defaultPhoneRegion: c.defaultPhoneRegion,
  privacyNotice: c.privacyNotice, status: c.status, activatedAt: c.activatedAt, slugLocked: c.activatedAt !== null, version: c.version,
});
const SETTINGS_KEYS = [
  'slotGranularityMin', 'holdMinutes', 'minNoticeMin', 'horizonDays', 'cancelCutoffMin', 'checkinBeforeMin', 'checkinAfterMin', 'noShowGraceMin',
  'maxActiveBookings', 'walkinEnabled', 'walkinDailyCapacity', 'walkinOpensOffsetMin', 'walkinClosesBeforeMin',
] as const;
const settingsView = (c: Clinic) => ({ ...Object.fromEntries(SETTINGS_KEYS.map((k) => [k, c[k]])), timezone: c.timezone, version: c.version });

const closureView = (c: { id: string; startDate: Date; endDate: Date; startMin: number | null; endMin: number | null; label: string | null }) => ({
  id: c.id, startDate: fromDate(c.startDate), endDate: fromDate(c.endDate),
  startTime: c.startMin === null ? null : `${String(Math.floor(c.startMin / 60)).padStart(2, '0')}:${String(c.startMin % 60).padStart(2, '0')}`,
  endTime: c.endMin === null ? null : `${String(Math.floor(c.endMin / 60)).padStart(2, '0')}:${String(c.endMin % 60).padStart(2, '0')}`,
  label: c.label,
});

/** clinic module (SC1-BE-07, SC1-BE-09): profile, settings, business hours, closures, services and eligibility. */
export function clinicRoutes(deps: Deps): Router {
  const r = Router();
  const { prisma, clock } = deps;
  const anyStaff = staffChain(deps); // GET profile/settings: all staff of the selected clinic (Arch 13)
  const loadClinic = (id: string) => prisma.clinic.findFirstOrThrow({ where: { id } });

  /** Optimistic concurrency on the clinic row (If-Match). */
  async function updateClinic(req: Parameters<Parameters<typeof h>[0]>[0], data: Prisma.ClinicUpdateManyMutationInput, action: string, changes: Prisma.InputJsonValue) {
    const ctx = req.clinic!;
    const now = clock.now();
    const current = await loadClinic(ctx.clinicId);
    const expected = ifMatchVersion(req) ?? current.version;
    await prisma.$transaction(async (tx) => {
      const n = await tx.clinic.updateMany({ where: { id: ctx.clinicId, version: expected }, data: { ...data, version: { increment: 1 } } });
      if (n.count === 0) throw new AppError('VERSION_CONFLICT', undefined, { current: { version: current.version } });
      await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action, entityType: 'clinic', entityId: ctx.clinicId, changes });
    });
    return loadClinic(ctx.clinicId);
  }

  r.get('/profile', ...anyStaff, h(async (req, res) => res.json(profileView(await loadClinic(req.clinic!.clinicId)))));
  r.patch('/profile', ...staffChain(deps, 'CAP-CLN-01', 'write'), h(async (req, res) => {
    const body = parse(UpdateProfileRequest, req.body);
    const current = await loadClinic(req.clinic!.clinicId);
    // FR-CLN-002 / A-017: slug and time zone are locked after first activation (also enforced by trigger).
    if (current.activatedAt && body.slug !== undefined && body.slug !== current.slug) throw fieldError('slug', 'The slug cannot change after activation');
    if (current.activatedAt && body.timezone !== undefined && body.timezone !== current.timezone) throw fieldError('timezone', 'The time zone cannot change after activation');
    if (body.slug && body.slug !== current.slug && (await prisma.clinic.findFirst({ where: { slug: body.slug } }))) throw fieldError('slug', 'This slug is already taken');
    const { contactPhone, ...rest } = body;
    const updated = await updateClinic(req, { ...rest, ...(contactPhone !== undefined ? { contactPhoneE164: contactPhone } : {}) }, 'clinic.profile_updated', { fields: Object.keys(body) });
    res.json(profileView(updated));
  }));

  r.get('/settings', ...anyStaff, h(async (req, res) => res.json(settingsView(await loadClinic(req.clinic!.clinicId)))));
  r.patch('/settings', ...staffChain(deps, 'CAP-CLN-01', 'write'), h(async (req, res) => {
    const body = parse(UpdateSettingsRequest, req.body);
    const current = await loadClinic(req.clinic!.clinicId);
    const merged = { ...current, ...body };
    if (merged.walkinEnabled && merged.walkinDailyCapacity == null) throw fieldError('walkinDailyCapacity', 'Required when QR walk-in is enabled');
    const updated = await updateClinic(req, body, 'clinic.settings_updated', body as Prisma.InputJsonValue);
    res.json(settingsView(updated));
  }));

  // Business hours (FR-CLN-003): whole week replaced atomically.
  r.get('/business-hours', ...staffChain(deps, 'CAP-CLN-02', 'read'), h(async (req, res) => {
    const rows = await prisma.clinicBusinessHour.findMany({ where: { clinicId: req.clinic!.clinicId } });
    res.json({ timezone: req.clinic!.timezone, days: intervalsToWeek(rows) });
  }));
  r.put('/business-hours', ...staffChain(deps, 'CAP-CLN-02', 'write'), h(async (req, res) => {
    const week = parse(WeekSchedule, req.body);
    const ctx = req.clinic!;
    const now = clock.now();
    const rows = week.days.flatMap((d) => dayToIntervals(d).map((i) => ({ clinicId: ctx.clinicId, weekday: d.weekday, startMin: i.startMin, endMin: i.endMin, createdAt: now })));
    await prisma.$transaction(async (tx) => {
      await tx.clinicBusinessHour.deleteMany({ where: { clinicId: ctx.clinicId } });
      await tx.clinicBusinessHour.createMany({ data: rows });
      await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'clinic.hours_updated', entityType: 'clinic', entityId: ctx.clinicId, changes: { intervals: rows.length } });
    });
    // Conflict scan for existing appointments is enqueued once appointments exist (SC-2, FR-CLN-008).
    res.json({ timezone: ctx.timezone, days: intervalsToWeek(rows) });
  }));

  // Closures (FR-CLN-004).
  const closureData = (body: ReturnType<typeof ClosureRequest.parse>) => ({
    startDate: toDate(body.startDate), endDate: toDate(body.endDate),
    startMin: body.startTime ? toMinutes(body.startTime) : null, endMin: body.endTime ? toMinutes(body.endTime) : null, label: body.label ?? null,
  });
  r.get('/closures', ...staffChain(deps, 'CAP-CLN-02', 'read'), h(async (req, res) => {
    const rows = await prisma.clinicClosure.findMany({ where: { clinicId: req.clinic!.clinicId }, orderBy: { startDate: 'asc' } });
    res.json({ items: rows.map(closureView) });
  }));
  r.post('/closures', ...staffChain(deps, 'CAP-CLN-02', 'write'), h(async (req, res) => {
    const body = parse(ClosureRequest, req.body);
    const ctx = req.clinic!;
    const now = clock.now();
    const row = await prisma.$transaction(async (tx) => {
      const c = await tx.clinicClosure.create({ data: { clinicId: ctx.clinicId, createdByMemberId: ctx.memberId, createdAt: now, ...closureData(body) } });
      await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'closure.created', entityType: 'clinic_closure', entityId: c.id, changes: { ...body } });
      return c;
    });
    res.status(201).json(closureView(row));
  }));
  r.patch('/closures/:id', ...staffChain(deps, 'CAP-CLN-02', 'write'), h(async (req, res) => {
    const body = parse(ClosureRequest, req.body);
    const ctx = req.clinic!;
    const id = uuidParam(req, 'id');
    const now = clock.now();
    const row = await prisma.$transaction(async (tx) => {
      const n = await tx.clinicClosure.updateMany({ where: { id, clinicId: ctx.clinicId }, data: closureData(body) });
      if (n.count === 0) throw notFound();
      await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'closure.updated', entityType: 'clinic_closure', entityId: id, changes: { ...body } });
      return tx.clinicClosure.findFirstOrThrow({ where: { id, clinicId: ctx.clinicId } });
    });
    res.json(closureView(row));
  }));
  r.delete('/closures/:id', ...staffChain(deps, 'CAP-CLN-02', 'write'), h(async (req, res) => {
    const ctx = req.clinic!;
    const id = uuidParam(req, 'id');
    const now = clock.now();
    await prisma.$transaction(async (tx) => {
      const n = await tx.clinicClosure.deleteMany({ where: { id, clinicId: ctx.clinicId } });
      if (n.count === 0) throw notFound();
      await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'closure.deleted', entityType: 'clinic_closure', entityId: id });
    });
    res.status(204).end();
  }));

  // FR-QR-001..003: one permanent QR per clinic encoding only the canonical public URL (no token, no personal data).
  const publicUrl = (slug: string) => `${deps.env.PUBLIC_BASE_URL ?? deps.env.APP_ORIGIN}/c/${slug}?src=qr`;
  r.get('/qr.:format(png|svg)', ...staffChain(deps, 'CAP-CLN-08', 'read'), h(async (req, res) => {
    const c = await loadClinic(req.clinic!.clinicId);
    const url = publicUrl(c.slug);
    res.setHeader('Content-Disposition', `attachment; filename="${c.slug}-qr.${req.params.format}"`);
    res.setHeader('X-QR-Url', url);
    if (req.params.format === 'svg') res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 }));
    else res.type('image/png').send(await QRCode.toBuffer(url, { type: 'png', width: 1024, errorCorrectionLevel: 'M', margin: 2 }));
  }));

  return r;
}

/** Services and doctor eligibility (FR-SVC-001..003, CAP-CLN-04), mounted at /api/services. */
export function serviceRoutes(deps: Deps): Router {
  const r = Router();
  const { prisma, clock } = deps;
  const include = { doctors: { select: { doctorId: true } } } as const;
  type Row = Prisma.ClinicServiceGetPayload<{ include: typeof include }>;
  const view = (s: Row) => ({
    id: s.id, name: s.name, description: s.description, durationMin: s.durationMin, onlineBookingEnabled: s.onlineBookingEnabled, walkInEnabled: s.walkInEnabled,
    isActive: s.isActive, displayOrder: s.displayOrder, doctorIds: s.doctors.map((d) => d.doctorId),
  });
  const load = async (clinicId: string, id: string) => {
    const s = await prisma.clinicService.findFirst({ where: { id, clinicId }, include });
    if (!s) throw notFound();
    return s;
  };

  r.get('/', ...staffChain(deps, 'CAP-CLN-04', 'read'), h(async (req, res) => {
    const rows = await prisma.clinicService.findMany({ where: { clinicId: req.clinic!.clinicId }, include, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }] });
    res.json({ items: rows.map(view) });
  }));
  r.post('/', ...staffChain(deps, 'CAP-CLN-04', 'write'), h(async (req, res) => {
    const body = parse(CreateServiceRequest, req.body);
    const ctx = req.clinic!;
    const now = clock.now();
    const s = await prisma.$transaction(async (tx) => {
      const s = await tx.clinicService.create({ data: { ...body, description: body.description ?? null, clinicId: ctx.clinicId, createdAt: now } });
      await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'service.created', entityType: 'clinic_service', entityId: s.id, changes: body });
      return s;
    });
    res.status(201).json(view(await load(ctx.clinicId, s.id)));
  }));
  r.patch('/:id', ...staffChain(deps, 'CAP-CLN-04', 'write'), h(async (req, res) => {
    const body = parse(UpdateServiceRequest, req.body);
    const ctx = req.clinic!;
    const id = uuidParam(req, 'id');
    const now = clock.now();
    await prisma.$transaction(async (tx) => {
      const n = await tx.clinicService.updateMany({ where: { id, clinicId: ctx.clinicId }, data: body });
      if (n.count === 0) throw notFound();
      await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'service.updated', entityType: 'clinic_service', entityId: id, changes: body });
    });
    res.json(view(await load(ctx.clinicId, id)));
  }));
  // FR-SVC-003: delete only while unreferenced. Appointment/queue references (RESTRICT FKs) arrive in SC-2/SC-3;
  // a reference then fails the delete with 23503 and the service must be deactivated instead.
  r.delete('/:id', ...staffChain(deps, 'CAP-CLN-04', 'write'), h(async (req, res) => {
    const ctx = req.clinic!;
    const id = uuidParam(req, 'id');
    const now = clock.now();
    await prisma.$transaction(async (tx) => {
      const n = await tx.clinicService.deleteMany({ where: { id, clinicId: ctx.clinicId } });
      if (n.count === 0) throw notFound();
      await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'service.deleted', entityType: 'clinic_service', entityId: id });
    });
    res.status(204).end();
  }));
  // FR-SVC-002: replace eligible doctors; every doctor must belong to the selected clinic.
  r.put('/:id/doctors', ...staffChain(deps, 'CAP-CLN-04', 'write'), h(async (req, res) => {
    const { doctorIds } = parse(ServiceDoctorsRequest, req.body);
    const ctx = req.clinic!;
    const id = uuidParam(req, 'id');
    const now = clock.now();
    await load(ctx.clinicId, id);
    const unique = [...new Set(doctorIds)];
    if ((await prisma.doctor.count({ where: { clinicId: ctx.clinicId, id: { in: unique } } })) !== unique.length) throw notFound();
    await prisma.$transaction(async (tx) => {
      await tx.doctorService.deleteMany({ where: { clinicId: ctx.clinicId, serviceId: id } });
      await tx.doctorService.createMany({ data: unique.map((doctorId) => ({ clinicId: ctx.clinicId, serviceId: id, doctorId, createdAt: now })) });
      await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'service.doctors_updated', entityType: 'clinic_service', entityId: id, changes: { doctorIds: unique } });
    });
    res.json(view(await load(ctx.clinicId, id)));
  }));

  return r;
}
