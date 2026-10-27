import type { Response } from 'express';
import { SESSION_ABSOLUTE_HOURS, SESSION_IDLE_MIN } from '@sc/config';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { hmac, randomToken, sha256 } from '../../infra/crypto';
import type { Deps } from '../../infra/context';
import { randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'sc_sid';
type Db = PrismaClient | Prisma.TransactionClient;

export const csrfTokenFor = (secret: Uint8Array) => hmac(secret, 'csrf').toString('base64url');

export async function createSession(
  db: Db,
  now: Date,
  data: { userId: string; ipHash: Buffer<ArrayBuffer> | null; userAgent?: string; activeClinicId?: string | null; activeMemberId?: string | null },
) {
  const raw = randomToken(32); // 256-bit cookie value; only its SHA-256 is stored (ADR-003)
  const csrfSecret = Buffer.from(randomBytes(32));
  await db.session.create({
    data: {
      idHash: sha256(raw),
      userId: data.userId,
      csrfSecret,
      activeClinicId: data.activeClinicId ?? null,
      activeMemberId: data.activeMemberId ?? null,
      selectedAt: data.activeMemberId ? now : null,
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_MIN * 60_000),
      absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_HOURS * 3_600_000),
      ipHash: data.ipHash,
      userAgent: data.userAgent?.slice(0, 255) ?? null,
    },
  });
  return { raw, csrfSecret };
}

export function setSessionCookie(res: Response, deps: Deps, raw: string) {
  res.cookie(SESSION_COOKIE, raw, {
    httpOnly: true,
    secure: deps.env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_ABSOLUTE_HOURS * 3_600_000,
  });
}

export function clearSessionCookie(res: Response, deps: Deps) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: deps.env.COOKIE_SECURE, sameSite: 'lax', path: '/' });
}

/** Revokes every live session of a user (logout-all, password change/reset, global deactivation). */
export function revokeUserSessions(db: Db, userId: string, now: Date, reason: string) {
  return db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, revokeReason: reason } });
}

/** FR-STF-003: membership deactivation / role change clears the selection of sessions using that membership. */
export function clearMembershipSelection(db: Db, memberId: string) {
  return db.session.updateMany({ where: { activeMemberId: memberId, revokedAt: null }, data: { activeClinicId: null, activeMemberId: null, selectedAt: null } });
}
