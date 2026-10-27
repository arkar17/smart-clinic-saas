import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string) => Buffer.from(createHash('sha256').update(value).digest());
export const hmac = (key: Uint8Array | string, value: string) => Buffer.from(createHmac('sha256', key).update(value).digest());
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
/** One-time temporary password (FR-STF-002): 18 characters from a URL-safe alphabet; satisfies BR-080 length. */
export const temporaryPassword = () => randomBytes(14).toString('base64url').slice(0, 18);
