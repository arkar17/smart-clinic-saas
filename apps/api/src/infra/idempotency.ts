import type { Request } from 'express';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Prisma } from '../generated/prisma/index.js';
import { AppError } from './errors';
import { sha256 } from './crypto';

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETENTION_MS = 24 * 3_600_000;

export interface StoredResponse { status: number; body: unknown }

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

// ADR-011: AES-256-GCM, random 96-bit nonce, AAD = clinic_id|endpoint|key. Stored as nonce ‖ tag ‖ ciphertext.
function encrypt(key: Buffer, aad: string, plain: string): Buffer<ArrayBuffer> {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce).setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.from(Buffer.concat([nonce, c.getAuthTag(), body]));
}
function decrypt(key: Buffer, aad: string, blob: Uint8Array): string {
  const b = Buffer.from(blob);
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)).setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

/**
 * SRS 13.3 / BR-025 idempotency for public POSTs, run inside the business transaction:
 * a first request inserts IN_PROGRESS and completes it with the encrypted response in the same commit; a retry with
 * the same key and body replays the stored response; a different body → 422; a concurrent duplicate waits on the
 * primary key and then replays. Thrown errors roll the record back so the client may retry.
 */
export async function idempotent(
  tx: Prisma.TransactionClient,
  req: Request,
  opts: { clinicId: string; endpoint: string; encKey: string; now: Date },
  run: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  const idemKey = req.get('idempotency-key') ?? '';
  if (!KEY_RE.test(idemKey)) throw new AppError('BAD_REQUEST', 'A valid Idempotency-Key (UUID v4) header is required.');
  const requestHash = sha256(JSON.stringify(canonical(req.body ?? {})));
  const key = Buffer.from(opts.encKey, 'base64');
  const aad = `${opts.clinicId}|${opts.endpoint}|${idemKey}`;

  const inserted = await tx.$executeRaw`
    INSERT INTO idempotency_record (clinic_id, endpoint, idem_key, request_hash, state, created_at, expires_at)
    VALUES (${opts.clinicId}::uuid, ${opts.endpoint}, ${idemKey}::uuid, ${requestHash}, 'IN_PROGRESS', ${opts.now}, ${new Date(opts.now.getTime() + RETENTION_MS)})
    ON CONFLICT DO NOTHING`;
  if (inserted === 0) {
    const rec = await tx.idempotencyRecord.findFirst({ where: { clinicId: opts.clinicId, endpoint: opts.endpoint, idemKey } });
    if (!rec) throw new AppError('REQUEST_IN_PROGRESS', 'This request is already being processed.');
    if (!Buffer.from(rec.requestHash).equals(requestHash)) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used with a different request.');
    if (rec.state !== 'COMPLETED' || !rec.responseBodyEnc) throw new AppError('REQUEST_IN_PROGRESS', 'This request is already being processed.');
    return { status: rec.responseStatus!, body: JSON.parse(decrypt(key, aad, rec.responseBodyEnc)), replayed: true };
  }
  const out = await run();
  await tx.idempotencyRecord.update({
    where: { clinicId_endpoint_idemKey: { clinicId: opts.clinicId, endpoint: opts.endpoint, idemKey } },
    data: { state: 'COMPLETED', responseStatus: out.status, responseBodyEnc: encrypt(key, aad, JSON.stringify(out.body)) },
  });
  return { ...out, replayed: false };
}
