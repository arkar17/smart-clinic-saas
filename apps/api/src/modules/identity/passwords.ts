import argon2 from 'argon2';
import { fieldError } from '../../infra/errors';

// ADR-018: Argon2id, 19 MiB, t=2, p=1.
const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => argon2.hash(password, OPTIONS);
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;
/** Equalises timing for unknown emails (FR-SEC-003: responses must not reveal whether the email exists). */
export async function burnVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing-only');
  await verifyPassword(await dummyHash, password);
}

// BR-080 bundled list of common passwords (those of 12+ characters; shorter ones fail the length rule anyway).
const COMMON = new Set([
  'password1234', 'password12345', 'password123456', '123456789012', '1234567890123', 'qwertyuiop12', 'qwertyuiop123',
  'qwerty123456', '1q2w3e4r5t6y', 'iloveyou1234', 'administrator', 'welcome12345', 'letmein12345', 'passw0rd1234',
  'changeme1234', 'abcdefghijkl', 'aaaaaaaaaaaa', '111111111111', '000000000000', '987654321098', 'qazwsxedcrfv',
  'zaq12wsxcde3', 'trustno1trustno1', 'football1234', 'baseball1234', 'superman1234', 'sunshine1234', 'princess1234',
  'monkey123456', 'dragon123456', 'master123456', 'p@ssw0rd1234', 'password!234', 'clinic123456', 'doctor123456',
  'temporary123', 'welcome123456', 'smartclinic123', 'hospital1234', 'qwertyqwerty', 'asdfghjkl123',
]);

/** BR-080: 12–128 characters (schema), not equal to the email, not a common password. */
export function assertPasswordPolicy(password: string, email: string, field = 'newPassword'): void {
  if (password.toLowerCase() === email.toLowerCase()) throw fieldError(field, 'Password must not equal your email');
  if (COMMON.has(password.toLowerCase())) throw fieldError(field, 'This password is too common');
}
