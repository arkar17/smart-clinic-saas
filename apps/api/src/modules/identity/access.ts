import type { ClinicRole, ClinicStatus } from '@sc/contracts';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * BR-085 / Arch 7.2–7.3: a membership is selectable when it is active and its clinic is accessible —
 * ACTIVE, PENDING_SETUP (staff configuration before activation) or SUSPENDED for Clinic Admin read-only.
 */
export function isClinicAccessible(status: ClinicStatus, roles: readonly ClinicRole[]): boolean {
  if (status === 'SUSPENDED') return roles.includes('CLINIC_ADMIN');
  return true;
}

/** Active, accessible memberships of a user (login, /me, select-clinic). */
export async function accessibleMemberships(db: Db, userId: string) {
  const rows = await db.clinicMember.findMany({
    where: { userId, isActive: true },
    include: { clinic: { select: { id: true, name: true, status: true } }, doctor: { select: { id: true } } },
    orderBy: { clinic: { name: 'asc' } },
  });
  return rows.filter((m) => isClinicAccessible(m.clinic.status, m.roles));
}
