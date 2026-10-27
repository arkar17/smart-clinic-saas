import { Router, type Request } from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { ChangePasswordRequest, LoginRequest, SelectClinicRequest, type MeResponse } from '@sc/contracts';
import { LOCKOUT_DURATION_MIN, LOCKOUT_MAX_FAILURES, LOCKOUT_WINDOW_MIN } from '@sc/config';
import { randomBytes } from 'node:crypto';
import { AppError } from '../../infra/errors';
import { h } from '../../infra/http';
import { parse } from '../../infra/validate';
import type { Deps, Principal } from '../../infra/context';
import { writeAudit } from '../audit/index';
import { accessibleMemberships } from './access';
import { assertPasswordPolicy, burnVerify, hashPassword, verifyPassword } from './passwords';
import { clearSessionCookie, createSession, csrfTokenFor, revokeUserSessions, setSessionCookie } from './sessions';
import { requireCsrf, requirePasswordChanged, requireSession } from './middleware';

async function buildMe(deps: Deps, p: Principal, csrfSecret: Uint8Array, selected?: { clinicId: string | null; memberId: string | null }): Promise<MeResponse> {
  const memberships = await accessibleMemberships(deps.prisma, p.userId);
  const activeMemberId = selected ? selected.memberId : p.activeMemberId;
  const current = memberships.find((m) => m.id === activeMemberId);
  return {
    user: { id: p.userId, email: p.email, displayName: p.displayName, mustChangePassword: p.mustChangePassword, isPlatformAdmin: p.isPlatformAdmin },
    memberships: memberships.map((m) => ({ clinicId: m.clinicId, clinicName: m.clinic.name, clinicStatus: m.clinic.status, roles: m.roles, doctorId: m.doctor?.id ?? null })),
    selectedClinicId: current?.clinicId ?? null,
    roles: current?.roles ?? [],
    doctorId: current?.doctor?.id ?? null,
    csrfToken: csrfTokenFor(csrfSecret),
  };
}

export function authRoutes(deps: Deps): Router {
  const r = Router();
  const { prisma, clock } = deps;
  const loginLimiter = new RateLimiterMemory({ points: deps.env.LOGIN_RATE_LIMIT_PER_10_MIN, duration: 600 }); // per IP hash (ADR-017)
  const session = [requireSession(deps)];

  r.post('/login', h(async (req, res) => {
    try {
      await loginLimiter.consume(req.ctx.ipHash?.toString('hex') ?? 'unknown');
    } catch (e) {
      const ms = (e as { msBeforeNext?: number }).msBeforeNext ?? 60_000;
      throw new AppError('RATE_LIMITED', 'Too many attempts. Please wait.', { retryAfterSec: Math.ceil(ms / 1000) });
    }
    const body = parse(LoginRequest, req.body);
    const now = clock.now();
    const user = await prisma.user.findFirst({ where: { email: body.email } });
    const generic = new AppError('UNAUTHENTICATED', 'Email or password is incorrect.');
    if (!user) {
      await burnVerify(body.password);
      await writeAudit(prisma, req, now, { action: 'auth.login_failed', entityType: 'user', security: true, changes: { reason: 'unknown_account' } });
      throw generic;
    }
    if (user.lockedUntil && user.lockedUntil > now) {
      await writeAudit(prisma, req, now, { actorUserId: user.id, action: 'auth.login_blocked', entityType: 'user', entityId: user.id, security: true });
      throw new AppError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', { retryAfterSec: Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 1000) });
    }
    if (!(await verifyPassword(user.passwordHash, body.password))) {
      // FR-SEC-003: 5 failures within 15 min lock the account for 15 min; failures are counted from the audit trail.
      await writeAudit(prisma, req, now, { actorUserId: user.id, action: 'auth.login_failed', entityType: 'user', entityId: user.id, security: true });
      const failures = await prisma.auditLog.count({
        where: { action: 'auth.login_failed', entityType: 'user', entityId: user.id, occurredAt: { gt: new Date(now.getTime() - LOCKOUT_WINDOW_MIN * 60_000) } },
      });
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: Math.min(failures, 32767), lockedUntil: failures >= LOCKOUT_MAX_FAILURES ? new Date(now.getTime() + LOCKOUT_DURATION_MIN * 60_000) : null },
      });
      throw generic;
    }
    if (!user.isActive) {
      await writeAudit(prisma, req, now, { actorUserId: user.id, action: 'auth.login_failed', entityType: 'user', entityId: user.id, security: true, changes: { reason: 'account_inactive' } });
      throw generic;
    }

    const memberships = await accessibleMemberships(prisma, user.id);
    const isPlatformAdmin = user.platformRole === 'PLATFORM_ADMIN';
    if (!isPlatformAdmin && memberships.length === 0) {
      await writeAudit(prisma, req, now, { actorUserId: user.id, action: 'auth.login_failed', entityType: 'user', entityId: user.id, security: true, changes: { reason: 'no_active_membership' } });
      throw new AppError('NO_ACTIVE_MEMBERSHIP');
    }
    const only = !isPlatformAdmin && memberships.length === 1 ? memberships[0]! : undefined;
    const created = await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now } });
      const s = await createSession(tx, now, { userId: user.id, ipHash: req.ctx.ipHash, userAgent: req.get('user-agent'), activeClinicId: only?.clinicId, activeMemberId: only?.id });
      await writeAudit(tx, req, now, { actorUserId: user.id, clinicId: only?.clinicId, action: 'auth.login', entityType: 'user', entityId: user.id, security: true });
      return s;
    });
    setSessionCookie(res, deps, created.raw);
    const principal: Principal = {
      sessionIdHash: Buffer.alloc(0), userId: user.id, email: user.email, displayName: user.displayName, isPlatformAdmin,
      mustChangePassword: user.mustChangePassword, csrfSecret: created.csrfSecret, activeClinicId: only?.clinicId ?? null, activeMemberId: only?.id ?? null,
    };
    res.json(await buildMe(deps, principal, created.csrfSecret));
  }));

  r.get('/me', ...session, h(async (req, res) => {
    res.json(await buildMe(deps, req.principal!, req.principal!.csrfSecret));
  }));

  r.post('/logout', ...session, requireCsrf, h(async (req, res) => {
    const now = clock.now();
    await prisma.$transaction(async (tx) => {
      await tx.session.update({ where: { idHash: req.principal!.sessionIdHash }, data: { revokedAt: now, revokeReason: 'LOGOUT' } });
      await writeAudit(tx, req, now, { clinicId: req.principal!.activeClinicId, action: 'auth.logout', entityType: 'user', entityId: req.principal!.userId });
    });
    clearSessionCookie(res, deps);
    res.status(204).end();
  }));

  // FR-STF-007 / BR-085: the only way to set or change the active clinic. No X-Clinic-Id needed.
  r.post('/select-clinic', ...session, requirePasswordChanged, requireCsrf, h(async (req, res) => {
    const { clinicId } = parse(SelectClinicRequest, req.body);
    const p = req.principal!;
    const now = clock.now();
    const m = (await accessibleMemberships(prisma, p.userId)).find((x) => x.clinicId === clinicId);
    if (!m) throw new AppError('NO_ACTIVE_MEMBERSHIP', 'You have no active membership in that clinic.');
    const csrfSecret = Buffer.from(randomBytes(32)); // rotated on every selection/switch
    await prisma.$transaction(async (tx) => {
      await tx.session.update({ where: { idHash: p.sessionIdHash }, data: { activeClinicId: m.clinicId, activeMemberId: m.id, selectedAt: now, csrfSecret } });
      await writeAudit(tx, req, now, {
        clinicId: m.clinicId, action: p.activeClinicId ? 'auth.clinic_switched' : 'auth.clinic_selected', entityType: 'clinic_member', entityId: m.id,
        changes: { fromClinicId: p.activeClinicId },
      });
    });
    // SSE streams of this session are closed by the realtime hub once it exists (SC-3).
    res.json({ selectedClinicId: m.clinicId, roles: m.roles, doctorId: m.doctor?.id ?? null, csrfToken: csrfTokenFor(csrfSecret) });
  }));

  r.post('/change-password', ...session, requireCsrf, h(async (req: Request, res) => {
    const body = parse(ChangePasswordRequest, req.body);
    const p = req.principal!;
    const now = clock.now();
    const user = await prisma.user.findFirstOrThrow({ where: { id: p.userId } });
    if (!(await verifyPassword(user.passwordHash, body.currentPassword))) throw new AppError('VALIDATION_ERROR', undefined, { fields: { currentPassword: ['Current password is incorrect'] } });
    assertPasswordPolicy(body.newPassword, user.email);
    const passwordHash = await hashPassword(body.newPassword);
    const created = await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: now, mustChangePassword: false } });
      await revokeUserSessions(tx, user.id, now, 'PASSWORD_CHANGED');
      const s = await createSession(tx, now, { userId: user.id, ipHash: req.ctx.ipHash, userAgent: req.get('user-agent'), activeClinicId: p.activeClinicId, activeMemberId: p.activeMemberId });
      await writeAudit(tx, req, now, { clinicId: p.activeClinicId, action: 'auth.password_changed', entityType: 'user', entityId: user.id, security: true });
      return s;
    });
    setSessionCookie(res, deps, created.raw);
    res.json(await buildMe(deps, { ...p, mustChangePassword: false }, created.csrfSecret));
  }));

  return r;
}
