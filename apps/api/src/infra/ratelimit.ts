import { RateLimiterMemory } from 'rate-limiter-flexible';
import { AppError } from './errors';
import { h } from './http';

/** Per-IP-hash limiter middleware (ADR-017); 429 with Retry-After. */
export function rateLimit(points: number, duration: number, message: string) {
  const limiter = new RateLimiterMemory({ points, duration });
  return h(async (req, _res, next) => {
    try {
      await limiter.consume(req.ctx.ipHash?.toString('hex') ?? 'unknown');
    } catch (e) {
      throw new AppError('RATE_LIMITED', message, { retryAfterSec: Math.ceil(((e as { msBeforeNext?: number }).msBeforeNext ?? 60_000) / 1000) });
    }
    next();
  });
}
