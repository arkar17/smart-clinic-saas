import { randomBytes } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/index.js';
import { randomToken, sha256 } from '../../infra/crypto';
import type { Deps } from '../../infra/context';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BOOKING_LINK_DAYS = 7; // BR-023

/** BR-020: SC-XXXXXXXX, 8 random Crockford Base32 characters; uniqueness per clinic is a database constraint. */
export function newBookingReference(): string {
  return `SC-${[...randomBytes(8)].map((b) => CROCKFORD[b % 32]).join('')}`;
}

export const bookingLinkExpiry = (from: Date) => new Date(from.getTime() + BOOKING_LINK_DAYS * 86_400_000);

/** BR-022: 256-bit token; only its SHA-256 is stored. Returns the raw value for the one-time response. */
export async function issueBookingToken(tx: Prisma.TransactionClient, clinicId: string, appointmentId: string, startAt: Date, now: Date, createdByMemberId: string | null = null) {
  const raw = randomToken(32);
  await tx.publicAccessToken.create({ data: { clinicId, purpose: 'BOOKING', tokenHash: sha256(raw), appointmentId, expiresAt: bookingLinkExpiry(startAt), createdByMemberId, createdAt: now } });
  return raw;
}

export const privateBookingUrl = (deps: Deps, slug: string, raw: string) => `${deps.env.PUBLIC_BASE_URL ?? deps.env.APP_ORIGIN}/c/${slug}/b/${raw}`;

/** A reference not yet used in the clinic (checked up to 5 times; the unique constraint remains the final guard). */
export async function freshReference(tx: Prisma.TransactionClient, clinicId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = newBookingReference();
    if (!(await tx.appointment.findFirst({ where: { clinicId, bookingReference: ref }, select: { id: true } }))) return ref;
  }
  throw new Error('Could not allocate a booking reference');
}
