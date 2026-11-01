import { z } from 'zod';

/** Server configuration from environment variables (see .env.example). Secrets never have defaults in production. */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  IP_HASH_PEPPER: z.string().min(16),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.coerce.number().int().default(1),
  LOGIN_RATE_LIMIT_PER_10_MIN: z.coerce.number().int().default(20),
  PUBLIC_RATE_LIMIT_PER_MIN: z.coerce.number().int().default(120),
  HOLD_RATE_LIMIT_PER_MIN: z.coerce.number().int().default(10),
  TOKEN_FAILURE_LIMIT_PER_10_MIN: z.coerce.number().int().default(20),
  /** ADR-011: base64 of 32 random bytes; encrypts idempotent responses that contain private links. */
  IDEMPOTENCY_ENC_KEY: z.string().refine((k) => Buffer.from(k, 'base64').length === 32, 'Must be base64 of 32 bytes'),
  /** Canonical public host encoded in clinic QR codes (FR-QR-001); defaults to APP_ORIGIN. */
  PUBLIC_BASE_URL: z.string().url().optional(),
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const env = EnvSchema.parse(source);
  // Release guard: production must run behind HTTPS with Secure cookies and a real APP_ORIGIN.
  if (env.NODE_ENV === 'production' && (!env.COOKIE_SECURE || !env.APP_ORIGIN.startsWith('https://'))) {
    throw new Error('Production requires COOKIE_SECURE=true and an https:// APP_ORIGIN');
  }
  return env;
}

/** A-024 session lifetimes and FR-SEC-003 lockout parameters. */
export const SESSION_IDLE_MIN = 60;
export const SESSION_ABSOLUTE_HOURS = 12;
export const SESSION_TOUCH_INTERVAL_SEC = 60;
export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_WINDOW_MIN = 15;
export const LOCKOUT_DURATION_MIN = 15;
export const MAX_INTERVALS_PER_DAY = 4;
