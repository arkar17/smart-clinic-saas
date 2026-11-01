import { Router } from 'express';
import { CreateClinicRequest, Email, ReasonRequest } from '@sc/contracts';
import { z } from 'zod';
import { AppError, fieldError, forbidden, notFound } from '../../infra/errors';
import { h, uuidParam } from '../../infra/http';
import { parse } from '../../infra/validate';
import type { Deps } from '../../infra/context';
import { writeAudit } from '../audit/index';
import { addMembershipByEmail, platformChain, resetPassword, revokeUserSessions } from '../identity/index';

/** FR-PLT-002 setup checklist. */
export async function setupChecklist(prisma: Deps['prisma'], clinicId: string): Promise<string[]> {
  const [hours, services, doctors] = await Promise.all([
    prisma.clinicBusinessHour.count({ where: { clinicId } }),
    prisma.clinicService.count({ where: { clinicId, isActive: true } }),
    prisma.doctor.count({ where: { clinicId, isActive: true, availability: { some: {} }, services: { some: { service: { isActive: true } } } } }),
  ]);
  const missing: string[] = [];
  if (!hours) missing.push('WEEKLY_OPERATING_HOURS');
  if (!services) missing.push('ACTIVE_SERVICE');
  if (!doctors) missing.push('ACTIVE_DOCTOR_WITH_SCHEDULE_AND_ELIGIBLE_SERVICE');
  return missing;
}

/** Platform realm (FR-PLT-001..006). No patient-level data is exposed here (FR-SEC-011). */
export function platformRoutes(deps: Deps): Router {
  const r = Router();
  const { prisma, clock } = deps;

  const clinicView = (c: { id: string; name: string; slug: string; status: string; statusReason: string | null; timezone: string; createdAt: Date; activatedAt: Date | null }, activeMembers: number) => ({
    id: c.id, name: c.name, slug: c.slug, status: c.status, statusReason: c.statusReason, timezone: c.timezone, createdAt: c.createdAt, activatedAt: c.activatedAt, activeMembershipCount: activeMembers,
  });

  r.get('/clinics', ...platformChain(deps, 'CAP-PLT-03'), h(async (_req, res) => {
    const clinics = await prisma.clinic.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { members: { where: { isActive: true } } } } } });
    // FR-PLT-004 aggregate counts only (no patient-level data): this month's confirmed appointments and queue visits.
    const since = new Date(clock.now().getTime() - 30 * 86_400_000);
    const [appts, visits] = await Promise.all([
      prisma.appointment.groupBy({ by: ['clinicId'], where: { confirmedAt: { gte: since } }, _count: true }),
      prisma.queueEntry.groupBy({ by: ['clinicId'], where: { registeredAt: { gte: since } }, _count: true }),
    ]);
    const count = (rows: { clinicId: string; _count: number }[], id: string) => rows.find((r) => r.clinicId === id)?._count ?? 0;
    res.json({ items: clinics.map((c) => ({ ...clinicView(c, c._count.members), appointmentsLast30Days: count(appts, c.id), queueVisitsLast30Days: count(visits, c.id) })) });
  }));

  r.post('/clinics', ...platformChain(deps, 'CAP-PLT-01'), h(async (req, res) => {
    const body = parse(CreateClinicRequest, req.body);
    const now = clock.now();
    if (await prisma.clinic.findFirst({ where: { slug: body.slug } })) throw fieldError('slug', 'This slug is already taken');
    const out = await prisma.$transaction(async (tx) => {
      const clinic = await tx.clinic.create({
        data: { name: body.name, slug: body.slug, timezone: body.timezone, defaultPhoneRegion: body.defaultPhoneRegion, createdByUserId: req.principal!.userId, createdAt: now },
      });
      await writeAudit(tx, req, now, { clinicId: clinic.id, action: 'clinic.created', entityType: 'clinic', entityId: clinic.id, toStatus: 'PENDING_SETUP' });
      const admin = await addMembershipByEmail(tx, req, now, { clinicId: clinic.id, email: body.adminEmail, displayName: body.adminName, roles: ['CLINIC_ADMIN'], createdByMemberId: null });
      return { clinic, admin };
    });
    res.status(201).json({
      clinic: clinicView(out.clinic, 1),
      admin: { userId: out.admin.user.id, email: out.admin.user.email, memberId: out.admin.member.id, existingAccount: out.admin.temporaryPassword === null },
      temporaryPassword: out.admin.temporaryPassword,
    });
  }));

  const transition = (action: 'activate' | 'suspend' | 'reactivate') =>
    h(async (req, res) => {
      const now = clock.now();
      const reason = action === 'activate' ? null : parse(ReasonRequest, req.body).reason;
      if (action === 'activate') parse(z.object({}).strict(), req.body);
      const clinic = await prisma.clinic.findFirst({ where: { id: uuidParam(req, 'id') } });
      if (!clinic) throw notFound();
      const from = { activate: 'PENDING_SETUP', suspend: 'ACTIVE', reactivate: 'SUSPENDED' }[action];
      if (clinic.status !== from) throw new AppError('INVALID_TRANSITION', `Clinic is ${clinic.status}.`, { current: { version: clinic.version } });
      if (action === 'activate') {
        const missing = await setupChecklist(prisma, clinic.id);
        if (missing.length) throw new AppError('SETUP_INCOMPLETE', 'The setup checklist is not complete.', { details: { missing } });
      }
      const to = action === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
      const updated = await prisma.$transaction(async (tx) => {
        const n = await tx.clinic.updateMany({
          where: { id: clinic.id, version: clinic.version },
          data: {
            status: to,
            statusReason: action === 'suspend' ? reason : null,
            suspendedAt: action === 'suspend' ? now : null,
            activatedAt: clinic.activatedAt ?? now,
            version: { increment: 1 },
          },
        });
        if (n.count === 0) throw new AppError('VERSION_CONFLICT');
        await writeAudit(tx, req, now, { clinicId: clinic.id, action: `clinic.${action}`, entityType: 'clinic', entityId: clinic.id, fromStatus: from, toStatus: to, reason });
        return tx.clinic.findFirstOrThrow({ where: { id: clinic.id }, include: { _count: { select: { members: { where: { isActive: true } } } } } });
      });
      if (action === 'suspend') deps.hub?.closeClinic(clinic.id); // FR-PLT-003: live streams end; Clinic Admins may reconnect read-only
      res.json(clinicView(updated, updated._count.members));
    });
  r.post('/clinics/:id/activate', ...platformChain(deps, 'CAP-PLT-02'), transition('activate'));
  r.post('/clinics/:id/suspend', ...platformChain(deps, 'CAP-PLT-02'), transition('suspend'));
  r.post('/clinics/:id/reactivate', ...platformChain(deps, 'CAP-PLT-02'), transition('reactivate'));

  r.get('/users', ...platformChain(deps, 'CAP-PLT-06'), h(async (req, res) => {
    const { email } = parse(z.object({ email: Email }).strict(), req.query);
    const user = await prisma.user.findFirst({ where: { email }, include: { memberships: { include: { clinic: { select: { name: true, slug: true, status: true } } } } } });
    if (!user) throw notFound();
    res.json({
      id: user.id, email: user.email, displayName: user.displayName, isActive: user.isActive, deactivationReason: user.deactivationReason,
      isPlatformAdmin: user.platformRole === 'PLATFORM_ADMIN', mustChangePassword: user.mustChangePassword, lastLoginAt: user.lastLoginAt, lockedUntil: user.lockedUntil,
      memberships: user.memberships.map((m) => ({ memberId: m.id, clinicId: m.clinicId, clinicName: m.clinic.name, clinicSlug: m.clinic.slug, clinicStatus: m.clinic.status, roles: m.roles, isActive: m.isActive })),
    });
  }));

  const loadStaffAccount = async (id: string) => {
    const user = await prisma.user.findFirst({ where: { id } });
    if (!user) throw notFound();
    if (user.platformRole === 'PLATFORM_ADMIN') throw forbidden('Platform Administrator accounts are not managed here.');
    return user;
  };

  // FR-PLT-005 (SHOULD): the only reset path for accounts with memberships in several clinics (BR-084).
  r.post('/users/:id/password-reset', ...platformChain(deps, 'CAP-PLT-04'), h(async (req, res) => {
    parse(z.object({}).strict(), req.body);
    const user = await loadStaffAccount(uuidParam(req, 'id'));
    const now = clock.now();
    const temporaryPassword = await prisma.$transaction((tx) => resetPassword(tx, req, now, user.id, null));
    deps.hub?.closeUser(user.id);
    res.json({ temporaryPassword });
  }));

  // FR-PLT-006 (SHOULD): global deactivation blocks login and revokes sessions in every clinic; memberships unchanged.
  r.post('/users/:id/deactivate', ...platformChain(deps, 'CAP-PLT-07'), h(async (req, res) => {
    const { reason } = parse(ReasonRequest, req.body);
    const user = await loadStaffAccount(uuidParam(req, 'id'));
    const now = clock.now();
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { isActive: false, deactivationReason: reason } });
      await revokeUserSessions(tx, user.id, now, 'DEACTIVATED');
      deps.hub?.closeUser(user.id);
      await writeAudit(tx, req, now, { action: 'account.deactivated', entityType: 'user', entityId: user.id, fromStatus: 'ACTIVE', toStatus: 'INACTIVE', reason, security: true });
    });
    res.json({ id: user.id, isActive: false });
  }));

  r.post('/users/:id/reactivate', ...platformChain(deps, 'CAP-PLT-07'), h(async (req, res) => {
    const { reason } = parse(ReasonRequest, req.body);
    const user = await loadStaffAccount(uuidParam(req, 'id'));
    const now = clock.now();
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { isActive: true, deactivationReason: null } });
      await writeAudit(tx, req, now, { action: 'account.reactivated', entityType: 'user', entityId: user.id, fromStatus: 'INACTIVE', toStatus: 'ACTIVE', reason, security: true });
    });
    res.json({ id: user.id, isActive: true });
  }));

  return r;
}
