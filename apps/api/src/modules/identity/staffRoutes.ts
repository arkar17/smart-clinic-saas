import { Router } from 'express';
import { AddStaffRequest, UpdateStaffRequest } from '@sc/contracts';
import type { Prisma } from '../../generated/prisma/index.js';
import { AppError, fieldError, forbidden, notFound } from '../../infra/errors';
import { h, uuidParam } from '../../infra/http';
import { parse } from '../../infra/validate';
import type { Deps } from '../../infra/context';
import { writeAudit } from '../audit/index';
import { staffChain } from './middleware';
import { addMembershipByEmail, hasOtherClinicMembership, resetPassword } from './accounts';
import { clearMembershipSelection } from './sessions';

const memberView = (m: { id: string; roles: string[]; isActive: boolean; deactivatedAt: Date | null; createdAt: Date; user: { id: string; email: string; displayName: string }; doctor: { id: string } | null }) => ({
  memberId: m.id,
  userId: m.user.id,
  email: m.user.email,
  displayName: m.user.displayName,
  roles: m.roles,
  isActive: m.isActive,
  deactivatedAt: m.deactivatedAt,
  doctorId: m.doctor?.id ?? null,
  createdAt: m.createdAt,
});
const include = { user: { select: { id: true, email: true, displayName: true } }, doctor: { select: { id: true } } } as const;

/** FR-STF-004: serialise admin changes per clinic and refuse removing the last active CLINIC_ADMIN. */
async function assertNotLastAdmin(tx: Prisma.TransactionClient, clinicId: string, memberId: string) {
  await tx.$queryRaw`SELECT id FROM clinic WHERE id = ${clinicId}::uuid FOR UPDATE`;
  const others = await tx.clinicMember.count({ where: { clinicId, isActive: true, roles: { has: 'CLINIC_ADMIN' }, id: { not: memberId } } });
  if (others === 0) throw new AppError('LAST_CLINIC_ADMIN', 'The clinic must keep at least one active Clinic Admin.');
}

export function staffRoutes(deps: Deps): Router {
  const r = Router();
  const { prisma, clock } = deps;
  const manage = staffChain(deps, 'CAP-CLN-07', 'write');

  const load = async (clinicId: string, memberId: string, tx: Prisma.TransactionClient = prisma) => {
    const m = await tx.clinicMember.findFirst({ where: { id: memberId, clinicId }, include });
    if (!m) throw notFound();
    return m;
  };

  r.get('/', ...manage, h(async (req, res) => {
    const rows = await prisma.clinicMember.findMany({ where: { clinicId: req.clinic!.clinicId }, include, orderBy: { createdAt: 'asc' } });
    res.json({ items: rows.map(memberView) });
  }));

  r.post('/', ...manage, h(async (req, res) => {
    const body = parse(AddStaffRequest, req.body);
    const now = clock.now();
    const ctx = req.clinic!;
    const out = await prisma.$transaction((tx) => addMembershipByEmail(tx, req, now, { clinicId: ctx.clinicId, email: body.email, displayName: body.displayName, roles: body.roles, createdByMemberId: ctx.memberId }));
    res.status(201).json({ member: memberView(await load(ctx.clinicId, out.member.id)), temporaryPassword: out.temporaryPassword });
  }));

  r.patch('/:memberId', ...manage, h(async (req, res) => {
    const body = parse(UpdateStaffRequest, req.body);
    const now = clock.now();
    const ctx = req.clinic!;
    await prisma.$transaction(async (tx) => {
      const m = await load(ctx.clinicId, uuidParam(req, 'memberId'), tx);
      if (body.roles) {
        if (m.roles.includes('CLINIC_ADMIN') && !body.roles.includes('CLINIC_ADMIN') && m.isActive) await assertNotLastAdmin(tx, ctx.clinicId, m.id);
        if (m.doctor && !body.roles.includes('DOCTOR')) throw fieldError('roles', 'Unlink the doctor profile before removing the DOCTOR role');
        await tx.clinicMember.update({ where: { id: m.id }, data: { roles: body.roles } });
        await clearMembershipSelection(tx, m.id);
        deps.hub?.closeMember(m.id);
        await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'membership.roles_changed', entityType: 'clinic_member', entityId: m.id, changes: { from: m.roles, to: body.roles } });
      }
      if (body.email && body.email !== m.user.email) {
        if (await hasOtherClinicMembership(tx, m.user.id, ctx.clinicId)) throw forbidden('This account also belongs to another clinic; only the account owner or the Platform Administrator can change its email.');
        if (await tx.user.findFirst({ where: { email: body.email } })) throw fieldError('email', 'This email is already in use');
        await tx.user.update({ where: { id: m.user.id }, data: { email: body.email } });
        await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'account.email_changed', entityType: 'user', entityId: m.user.id, security: true });
      }
    });
    res.json(memberView(await load(ctx.clinicId, uuidParam(req, 'memberId'))));
  }));

  r.post('/:memberId/deactivate', ...manage, h(async (req, res) => {
    const now = clock.now();
    const ctx = req.clinic!;
    await prisma.$transaction(async (tx) => {
      const m = await load(ctx.clinicId, uuidParam(req, 'memberId'), tx);
      if (!m.isActive) return;
      if (m.roles.includes('CLINIC_ADMIN')) await assertNotLastAdmin(tx, ctx.clinicId, m.id);
      await tx.clinicMember.update({ where: { id: m.id }, data: { isActive: false, deactivatedAt: now } });
      await clearMembershipSelection(tx, m.id); // FR-STF-003: access to this clinic ends; global account untouched
      deps.hub?.closeMember(m.id); // and its live streams close (TC-STF-005)
      await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'membership.deactivated', entityType: 'clinic_member', entityId: m.id, fromStatus: 'ACTIVE', toStatus: 'INACTIVE' });
    });
    res.json(memberView(await load(ctx.clinicId, uuidParam(req, 'memberId'))));
  }));

  r.post('/:memberId/reactivate', ...manage, h(async (req, res) => {
    const now = clock.now();
    const ctx = req.clinic!;
    await prisma.$transaction(async (tx) => {
      const m = await load(ctx.clinicId, uuidParam(req, 'memberId'), tx);
      if (m.isActive) return;
      await tx.clinicMember.update({ where: { id: m.id }, data: { isActive: true, deactivatedAt: null } });
      await writeAudit(tx, req, now, { clinicId: ctx.clinicId, action: 'membership.reactivated', entityType: 'clinic_member', entityId: m.id, fromStatus: 'INACTIVE', toStatus: 'ACTIVE' });
    });
    res.json(memberView(await load(ctx.clinicId, uuidParam(req, 'memberId'))));
  }));

  // FR-STF-005 (SHOULD) / BR-084: only for accounts without a membership in another clinic.
  r.post('/:memberId/reset-password', ...staffChain(deps, 'CAP-CLN-09', 'write'), h(async (req, res) => {
    const now = clock.now();
    const ctx = req.clinic!;
    const temporary = await prisma.$transaction(async (tx) => {
      const m = await load(ctx.clinicId, uuidParam(req, 'memberId'), tx);
      if (await hasOtherClinicMembership(tx, m.user.id, ctx.clinicId)) throw forbidden('This account also belongs to another clinic; the Platform Administrator must reset it.');
      return resetPassword(tx, req, now, m.user.id, ctx.clinicId);
    });
    deps.hub?.closeWhere((x) => x.kind === 'staff' && x.clinicId === ctx.clinicId && x.memberId === uuidParam(req, 'memberId'));
    res.json({ temporaryPassword: temporary });
  }));

  return r;
}
