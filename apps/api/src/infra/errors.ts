import type { ErrorRequestHandler } from 'express';
import { ERROR_STATUS, type ErrorCode } from '@sc/contracts';
import { ZodError } from 'zod';
import { Prisma } from '../generated/prisma/index.js';

const DEFAULT_MESSAGES: Partial<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: 'Please sign in.',
  FORBIDDEN: 'You do not have permission to do this.',
  NOT_FOUND: 'Not found.',
  VALIDATION_ERROR: 'Please correct the highlighted fields.',
  CSRF_INVALID: 'Your session form token is invalid. Please reload the page.',
  CLINIC_CONTEXT_MISMATCH: 'The active clinic changed. Please reload.',
  CLINIC_SELECTION_REQUIRED: 'Please select a clinic.',
  NO_ACTIVE_MEMBERSHIP: 'Your account has no active clinic membership.',
  PASSWORD_CHANGE_REQUIRED: 'Please change your temporary password.',
  CLINIC_READ_ONLY: 'This clinic is suspended and read-only.',
  VERSION_CONFLICT: 'This record was changed by someone else. Please reload.',
  INTERNAL: 'Something went wrong.',
};

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message?: string,
    public extra: { fields?: Record<string, string[]>; details?: unknown; retryAfterSec?: number; current?: { version: number } } = {},
  ) {
    super(message ?? DEFAULT_MESSAGES[code] ?? code);
  }
}

export const notFound = () => new AppError('NOT_FOUND');
export const forbidden = (message?: string) => new AppError('FORBIDDEN', message);
export const fieldError = (path: string, message: string) => new AppError('VALIDATION_ERROR', undefined, { fields: { [path]: [message] } });

export function zodFields(err: ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    (fields[key] ??= []).push(issue.code === 'unrecognized_keys' ? `Unknown field(s): ${issue.keys.join(', ')}` : issue.message);
  }
  return fields;
}

/** Arch 15 PostgreSQL mapping: 23503 → NOT_FOUND, 23P01 / 23514 / 23505 → validation-level refusals. */
function mapDatabaseError(err: unknown): AppError | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2025') return notFound();
    if (err.code === 'P2003') return notFound();
    if (err.code === 'P2002') return new AppError('VALIDATION_ERROR', 'This value is already in use.', { details: { target: err.meta?.target } });
  }
  const message = err instanceof Error ? err.message : '';
  if (/appointment_no_overlap/.test(message)) return new AppError('SLOT_UNAVAILABLE', 'This time is no longer available. Please choose another.');
  if (/P0001|invalid appointment transition/.test(message)) return new AppError('INVALID_TRANSITION');
  if (/23P01|exclusion constraint/.test(message)) return new AppError('VALIDATION_ERROR', 'Intervals must not overlap.');
  if (/23503|foreign key constraint/.test(message)) return notFound();
  if (/23514|check constraint|immutable after activation/.test(message)) return new AppError('VALIDATION_ERROR', 'The value violates a data rule.');
  return null;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appErr: AppError;
  if (err instanceof AppError) appErr = err;
  else if (err instanceof ZodError) appErr = new AppError('VALIDATION_ERROR', undefined, { fields: zodFields(err) });
  else if (err?.type === 'entity.parse.failed') appErr = new AppError('BAD_REQUEST', 'Malformed JSON.');
  else appErr = mapDatabaseError(err) ?? new AppError('INTERNAL');

  // FR-SEC-010: Prisma messages can echo query arguments (names, phones), so only the error class, code and model are logged.
  if (appErr.code === 'INTERNAL') req.ctx?.log.error({ error: safeErrorSummary(err) }, 'unhandled error');
  if (appErr.extra.retryAfterSec) res.setHeader('Retry-After', String(appErr.extra.retryAfterSec));
  res.status(ERROR_STATUS[appErr.code]).json({
    error: { code: appErr.code, message: appErr.message, ...appErr.extra, requestId: req.ctx?.requestId ?? '' },
  });
};

export function safeErrorSummary(err: unknown) {
  const e = err as { name?: string; code?: string; meta?: { modelName?: string }; stack?: string };
  const isPrisma = typeof e?.name === 'string' && e.name.startsWith('PrismaClient');
  return {
    name: e?.name ?? typeof err,
    code: e?.code,
    model: e?.meta?.modelName,
    // Stack frames only (no message line) for non-database errors.
    stack: isPrisma ? undefined : e?.stack?.split('\n').slice(1, 6).join('\n'),
  };
}
