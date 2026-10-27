import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors';
import { hmac } from './crypto';
import { redactUrl } from './logger';
import type { Deps } from './context';

/** Wraps async handlers so rejections reach the error middleware (Express 4). */
export const h = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

export function requestContext(deps: Deps): RequestHandler {
  return (req, res, next) => {
    const requestId = randomUUID();
    const started = Date.now();
    const ip = req.ip ?? '';
    req.ctx = { requestId, log: deps.log.child({ requestId }), ipHash: ip ? hmac(deps.env.IP_HASH_PEPPER, ip) : null };
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
      req.ctx.log.info({ method: req.method, url: redactUrl(req.originalUrl), status: res.statusCode, ms: Date.now() - started }, 'request');
    });
    next();
  };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** FR-SEC-009 Origin check for every state-changing request (the CSRF token is checked after authentication). */
export function originCheck(deps: Deps): RequestHandler {
  return (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin') ?? (req.get('referer') ? new URL(req.get('referer')!).origin : undefined);
    if (origin !== deps.env.APP_ORIGIN) return next(new AppError('CSRF_INVALID'));
    next();
  };
}

/** Parses an If-Match version header for optimistic concurrency. */
export function ifMatchVersion(req: Request): number | undefined {
  const v = req.get('if-match');
  if (v === undefined) return undefined;
  const n = Number(v.replace(/"/g, ''));
  if (!Number.isInteger(n)) throw new AppError('BAD_REQUEST', 'Invalid If-Match header.');
  return n;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Path IDs that are not UUIDs are treated like foreign IDs: 404 (Arch 8.1). */
export function uuidParam(req: Request, name: string): string {
  const v = req.params[name];
  if (!v || !UUID_RE.test(v)) throw new AppError('NOT_FOUND');
  return v;
}

export const toDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
export const fromDate = (d: Date) => d.toISOString().slice(0, 10);
