import type { ClinicRole } from '@sc/contracts';
import type { Logger } from './logger';
import type { Clock } from './clock';
import type { PrismaClient } from '../generated/prisma/index.js';
import type { Env } from '@sc/config';

export interface Deps {
  prisma: PrismaClient;
  clock: Clock;
  env: Env;
  log: Logger;
}

export interface RequestCtx {
  requestId: string;
  log: Logger;
  ipHash: Buffer<ArrayBuffer> | null;
}

export interface Principal {
  sessionIdHash: Buffer<ArrayBuffer>;
  userId: string;
  email: string;
  displayName: string;
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
  csrfSecret: Buffer<ArrayBuffer>;
  activeClinicId: string | null;
  activeMemberId: string | null;
}

/** ClinicContext (ADR-004): built only from the session's re-validated selected membership. */
export interface ClinicContext {
  clinicId: string;
  memberId: string;
  userId: string;
  roles: ClinicRole[];
  doctorId: string | null;
  clinicStatus: 'PENDING_SETUP' | 'ACTIVE' | 'SUSPENDED';
  timezone: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: RequestCtx;
      principal?: Principal;
      clinic?: ClinicContext;
    }
  }
}
