import type { ZodTypeAny, z } from 'zod';
import { normalizeInput } from '@sc/contracts';
import { AppError, zodFields } from './errors';

/** FR-SEC-008: shared strict Zod schemas; strings NFC-normalised and trimmed first (TC-VAL-003). */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(normalizeInput(input ?? {}));
  if (!result.success) throw new AppError('VALIDATION_ERROR', undefined, { fields: zodFields(result.error) });
  return result.data;
}
