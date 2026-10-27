import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { SESSION_IDLE_MIN, SESSION_TOUCH_INTERVAL_SEC } from '@sc/config';
import { PERMISSION_MATRIX, resolveGrant, type AccessMode, type CapabilityId, type Grant } from '@sc/contracts';
import { AppError, forbidden, notFound } from '../../infra/errors';
import { parseCookies, h } from '../../infra/http';
import { safeEqual, sha256 } from '../../infra/crypto';
import type { Deps } from '../../infra/context';
import { SESSION_COOKIE, csrfTokenFor } from './sessions';
import { isClinicAccessible } from './access';

/** Loads and validates the staff session (FR-SEC-002, Arch 7.2). */
export function requireSession(deps: Deps): RequestHandler {
  return h(async (req, _res, next) => {
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw) throw new AppError('UNAUTHENTICATED');
    const now = deps.clock.now();
    const idHash = sha256(raw);
    const s = await deps.prisma.session.findFirst({ where: { idHash }, include: { user: true } });
    if (
      !s || s.revokedAt || s.idleExpiresAt <= now || s.absoluteExpiresAt <= now || !s.user.isActive ||
      (s.user.passwordChangedAt && s.createdAt < s.user.passwordChangedAt)
    ) throw new AppError('UNAUTHENTICATED');

    if (now.getTime() - s.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_SEC * 1000) {
      await deps.prisma.session.update({ where: { idHash }, data: { lastSeenAt: now, idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_MIN * 60_000) } });
    }
    req.principal = {
      sessionIdHash: idHash,
      userId: s.userId,
      email: s.user.email,
      displayName: s.user.displayName,
      isPlatformAdmin: s.user.platformRole === 'PLATFORM_ADMIN',
      mustChangePassword: s.user.mustChangePassword,
      csrfSecret: Buffer.from(s.csrfSecret),
      activeClinicId: s.activeClinicId,
      activeMemberId: s.activeMemberId,
    };
    next();
  });
}

/** FR-SEC-009 synchroniser token on every state-changing staff request. */
export const requireCsrf: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = req.get('x-csrf-token') ?? '';
  if (!req.principal || !safeEqual(sent, csrfTokenFor(req.principal.csrfSecret))) return next(new AppError('CSRF_INVALID'));
  next();
};

/** FR-STF-002: a temporary password must be changed before anything else. */
export const requirePasswordChanged: RequestHandler = (req, _res, next) => {
  if (req.principal?.mustChangePassword) return next(new AppError('PASSWORD_CHANGE_REQUIRED'));
  next();
};

/**
 * resolveClinicContext + X-Clinic-Id consistency check + clinicStatusGate (Arch 7.3, FR-SEC-005, FR-SEC-012).
 * The selected membership is re-loaded on every request; the header never selects anything.
 */
export function requireClinic(deps: Deps): RequestHandler {
  return h(async (req, _res, next) => {
    const p = req.principal!;
    if (!p.activeMemberId || !p.activeClinicId) throw new AppError('CLINIC_SELECTION_REQUIRED');
    const m = await deps.prisma.clinicMember.findFirst({
      where: { id: p.activeMemberId, clinicId: p.activeClinicId, userId: p.userId },
      include: { clinic: { select: { status: true, timezone: true } }, doctor: { select: { id: true } } },
    });
    if (!m || !m.isActive || !isClinicAccessible(m.clinic.status, m.roles)) throw new AppError('CLINIC_SELECTION_REQUIRED');
    if (req.get('x-clinic-id') !== m.clinicId) throw new AppError('CLINIC_CONTEXT_MISMATCH');
    if (m.clinic.status === 'SUSPENDED' && req.method !== 'GET') throw new AppError('CLINIC_READ_ONLY');
    req.clinic = {
      clinicId: m.clinicId,
      memberId: m.id,
      userId: p.userId,
      roles: m.roles,
      doctorId: m.doctor?.id ?? null,
      clinicStatus: m.clinic.status,
      timezone: m.clinic.timezone,
    };
    next();
  });
}

const grants = new WeakMap<Request, Grant>();
/** requirePermission(CAP-*) from the compiled matrix; union of the selected membership's roles only. */
export function requirePermission(cap: CapabilityId, mode: AccessMode): RequestHandler {
  return (req, _res, next) => {
    const grant = resolveGrant(cap, req.clinic?.roles ?? [], mode);
    if (!grant) return next(forbidden());
    grants.set(req, grant);
    next();
  };
}

/** scopeGuard for OWN grants (READ_OWN / ALLOW_OWN): cross-scope reads return 404. */
export function assertDoctorScope(req: Request, doctorId: string): void {
  if (grants.get(req) === 'OWN' && req.clinic?.doctorId !== doctorId) throw notFound();
}
export const grantOf = (req: Request): Grant => grants.get(req) ?? null;

/** Platform realm: PLATFORM_ADMIN only, capability must be ALLOW for the platform column. */
export function requirePlatform(cap: CapabilityId): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.principal?.isPlatformAdmin || PERMISSION_MATRIX[cap].PLATFORM_ADMIN !== 'ALLOW') return next(forbidden());
    next();
  };
}

/** Standard chains. */
export const staffChain = (deps: Deps, cap?: CapabilityId, mode: AccessMode = 'read') => {
  const chain: RequestHandler[] = [requireSession(deps), requirePasswordChanged, requireCsrf, requireClinic(deps)];
  if (cap) chain.push(requirePermission(cap, mode));
  return chain;
};
export const platformChain = (deps: Deps, cap: CapabilityId) => [requireSession(deps), requirePasswordChanged, requireCsrf, requirePlatform(cap)];
