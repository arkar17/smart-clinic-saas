import { z } from 'zod';
import { Email, Reason } from './common';

const RESERVED_SLUGS = ['admin', 'api', 'app', 'c', 'login', 'static', 'www'];
/** BR-010 clinic slug. */
export const Slug = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Lowercase letters, digits and single hyphens only')
  .refine((s) => !RESERVED_SLUGS.includes(s), 'This slug is reserved');

export function isValidTimeZone(tz: string): boolean {
  try {
    return Intl.supportedValuesOf('timeZone').includes(tz) || new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone === tz;
  } catch {
    return false;
  }
}
export const TimeZone = z.string().max(64).refine(isValidTimeZone, 'Unknown IANA time zone');
export const PhoneRegion = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 code');
export const DisplayName = z.string().min(2).max(100);

export const CreateClinicRequest = z
  .object({
    name: z.string().min(2).max(120),
    slug: Slug,
    timezone: TimeZone,
    defaultPhoneRegion: PhoneRegion,
    adminName: DisplayName,
    adminEmail: Email,
  })
  .strict();
export const ReasonRequest = z.object({ reason: Reason }).strict();
