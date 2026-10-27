import pino from 'pino';

/** FR-SEC-010: never log passwords, tokens, cookies or full phone numbers. */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'req.headers["x-access-token"]',
  'req.headers["x-display-key"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.temporaryPassword',
  '*.phone',
  '*.csrfToken',
];

export function createLogger(level: string) {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } });
}
export type Logger = ReturnType<typeof createLogger>;

/** Token-bearing web routes (/c/<slug>/b/<token>, /q/<token>) are redacted before logging (ADR-010). */
export function redactUrl(url: string): string {
  return url.replace(/\/(b|q)\/[^/?#]+/g, '/$1/[REDACTED]').replace(/([?&](token|key)=)[^&]+/gi, '$1[REDACTED]');
}
