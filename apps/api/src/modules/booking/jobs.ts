import type { PrismaClient } from '../../generated/prisma/index.js';

/** AT-03 (FR-APT-014): idempotent sweep; correctness never depends on it because expired holds are non-blocking at query time. */
export function expireHolds(prisma: PrismaClient, now: Date) {
  return prisma.$executeRaw`
    UPDATE appointment SET status = 'EXPIRED', expired_at = ${now}, reservation_secret_hash = NULL, hold_ip_hash = NULL, version = version + 1
    WHERE status = 'PENDING' AND hold_expires_at <= ${now}`;
}

/** Idempotency records are retained 24 h (BR-025). */
export function purgeIdempotency(prisma: PrismaClient, now: Date) {
  return prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lte: now } } });
}
