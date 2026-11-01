import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type { Request } from 'express';

type Db = PrismaClient | Prisma.TransactionClient;

export interface AuditEvent {
  clinicId?: string | null;
  actorUserId?: string | null;
  actorType?: 'STAFF' | 'PUBLIC_PATIENT' | 'SYSTEM';
  action: string;
  entityType: string;
  entityId?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  reason?: string | null;
  changes?: Prisma.InputJsonValue;
  security?: boolean;
}

/**
 * Append-only audit writer (FR-AUD-001..003). Call inside the business transaction so the event commits with the change.
 * `changes` must already be masked: never passwords, tokens or full phone numbers.
 */
export async function writeAudit(db: Db, req: Request, now: Date, e: AuditEvent): Promise<void> {
  await db.auditLog.create({
    data: {
      occurredAt: now,
      clinicId: e.clinicId ?? null,
      actorType: e.actorType ?? 'STAFF',
      actorUserId: e.actorUserId ?? req.principal?.userId ?? null,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId ?? null,
      fromStatus: e.fromStatus ?? null,
      toStatus: e.toStatus ?? null,
      reason: e.reason ?? null,
      requestId: req.ctx.requestId,
      ipHash: e.security ? req.ctx.ipHash : null,
      changes: e.changes,
    },
  });
}
