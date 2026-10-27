import type { Request } from 'express';
import type { ClinicRole } from '@sc/contracts';
import type { Prisma } from '../../generated/prisma/index.js';
import { fieldError } from '../../infra/errors';
import { temporaryPassword } from '../../infra/crypto';
import { writeAudit } from '../audit/index';
import { hashPassword } from './passwords';
import { revokeUserSessions } from './sessions';

/**
 * FR-STF-001/002, FR-PLT-001, BR-083: add a membership for an email. Creates a global account with a one-time
 * temporary password when the email is new; an existing account only gains a membership (password untouched).
 */
export async function addMembershipByEmail(
  tx: Prisma.TransactionClient,
  req: Request,
  now: Date,
  input: { clinicId: string; email: string; displayName: string; roles: ClinicRole[]; createdByMemberId: string | null },
) {
  let user = await tx.user.findFirst({ where: { email: input.email } });
  let temporary: string | null = null;
  if (user) {
    if (user.platformRole === 'PLATFORM_ADMIN') throw fieldError('email', 'Platform Administrator accounts cannot hold clinic memberships');
    if (await tx.clinicMember.findFirst({ where: { clinicId: input.clinicId, userId: user.id } })) throw fieldError('email', 'This account is already a member of this clinic');
  } else {
    temporary = temporaryPassword();
    user = await tx.user.create({
      data: { email: input.email, displayName: input.displayName, passwordHash: await hashPassword(temporary), mustChangePassword: true, createdAt: now },
    });
    await writeAudit(tx, req, now, { clinicId: input.clinicId, action: 'account.created', entityType: 'user', entityId: user.id });
  }
  const member = await tx.clinicMember.create({
    data: { clinicId: input.clinicId, userId: user.id, roles: input.roles, createdByMemberId: input.createdByMemberId, createdAt: now },
  });
  await writeAudit(tx, req, now, { clinicId: input.clinicId, action: 'membership.created', entityType: 'clinic_member', entityId: member.id, changes: { roles: input.roles } });
  return { user, member, temporaryPassword: temporary };
}

/** FR-PLT-005 / FR-STF-005: one-time temporary password, forced change, all sessions revoked. */
export async function resetPassword(tx: Prisma.TransactionClient, req: Request, now: Date, userId: string, clinicId: string | null) {
  const temporary = temporaryPassword();
  await tx.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(temporary), mustChangePassword: true, passwordChangedAt: now, lockedUntil: null } });
  await revokeUserSessions(tx, userId, now, 'ADMIN_RESET');
  await writeAudit(tx, req, now, { clinicId, action: 'account.password_reset', entityType: 'user', entityId: userId, security: true });
  return temporary;
}

/** BR-084: does the account hold a membership (active or not) in any other clinic? */
export async function hasOtherClinicMembership(tx: Prisma.TransactionClient, userId: string, clinicId: string) {
  return (await tx.clinicMember.count({ where: { userId, clinicId: { not: clinicId } } })) > 0;
}
