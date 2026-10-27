import { z } from 'zod';

/** BR-030 full name: 2–100 chars after trimming and collapsing whitespace; letters, spaces, apostrophe, hyphen, period. */
export const FULL_NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} '’.-]*$/u;
export const FullName = z
  .string()
  .transform((s) => s.normalize('NFC').trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(2, 'At least 2 characters').max(100, 'At most 100 characters').regex(FULL_NAME_RE, 'Use letters, spaces, apostrophes, hyphens or periods only'));

/** FR-PAT-002 matching key: lower-case, diacritics stripped, whitespace collapsed. */
export function normalizeName(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Raw phone as typed; parsed and validated on the server with the clinic's default region (BR-031). */
export const PhoneInput = z.string().min(3).max(32);

export const PatientSearchQuery = z.object({ q: z.string().min(2).max(100) }).strict();

/** BR-033 / BR-034 public display helpers. */
export const maskPhone = (e164: string) => `•••• ••• ${e164.slice(-4)}`;
export const firstName = (fullName: string) => fullName.split(' ')[0] ?? '';
