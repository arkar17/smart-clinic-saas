import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { FullName, normalizeName } from '@sc/contracts';
import { AppError } from '../../infra/errors';

/** BR-031: parse with the clinic's default region when there is no + prefix; must be valid; returns E.164 or null. */
export function parsePhone(raw: string, region: string): string | null {
  const parsed = parsePhoneNumberFromString(raw.trim(), region as CountryCode);
  return parsed?.isValid() ? parsed.number : null;
}

export interface PatientIdentity { fullName: string; nameNormalized: string; phoneE164: string }

/** BR-030 + BR-031 + BR-037: name and valid phone are both mandatory; no bypass. */
export function validatePatientIdentity(input: { fullName?: unknown; phone?: unknown }, region: string): PatientIdentity {
  const fields: Record<string, string[]> = {};
  const name = FullName.safeParse(input.fullName ?? '');
  if (!name.success) fields.fullName = name.error.issues.map((i) => i.message);
  const phone = typeof input.phone === 'string' ? parsePhone(input.phone, region) : null;
  if (!phone) fields.phone = ['Enter a valid phone number'];
  if (!name.success || !phone) throw new AppError('VALIDATION_ERROR', undefined, { fields });
  return { fullName: name.data, nameNormalized: normalizeName(name.data), phoneE164: phone };
}
