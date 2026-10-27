import { Router } from 'express';
import { PatientSearchQuery, normalizeName } from '@sc/contracts';
import { Prisma, type PatientSource, type PrismaClient } from '../../generated/prisma/index.js';
import { notFound } from '../../infra/errors';
import { h, uuidParam } from '../../infra/http';
import { parse } from '../../infra/validate';
import type { Deps } from '../../infra/context';
import { grantOf, staffChain } from '../identity/index';
import { parsePhone, type PatientIdentity } from './identity';

export { parsePhone, validatePatientIdentity, type PatientIdentity } from './identity';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * FR-PAT-002: reuse the clinic's patient whose normalised phone and name match; otherwise create one.
 * Matching never crosses clinics (FR-PAT-006). A concurrent insert of the same key hits patient_match_key and is re-read.
 */
export async function findOrCreatePatient(db: Db, clinicId: string, id: PatientIdentity, source: PatientSource, now: Date) {
  const where = { clinicId, phoneE164: id.phoneE164, nameNormalized: id.nameNormalized, anonymizedAt: null };
  const existing = await db.patient.findFirst({ where });
  if (existing) return { patient: existing, created: false };
  try {
    const patient = await db.patient.create({ data: { clinicId, fullName: id.fullName, nameNormalized: id.nameNormalized, phoneE164: id.phoneE164, source, createdAt: now } });
    return { patient, created: true };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { patient: await db.patient.findFirstOrThrow({ where }), created: false };
    throw e;
  }
}

const view = (p: { id: string; fullName: string; phoneE164: string | null; source: string; createdAt: Date; anonymizedAt: Date | null }) => ({
  id: p.id, fullName: p.fullName, phone: p.phoneE164, source: p.source, createdAt: p.createdAt, anonymized: p.anonymizedAt !== null,
});

/** Staff retrieval and search (FR-PAT-003, FR-PAT-005, CAP-PAT-01). Appointment/queue history joins arrive with SC-2B/SC-3. */
export function patientRoutes(deps: Deps): { patients: Router; search: Router } {
  const { prisma } = deps;
  const patients = Router();
  const search = Router();
  const read = staffChain(deps, 'CAP-PAT-01', 'read');

  patients.get('/:id', ...read, h(async (req, res) => {
    // DR (ALLOW_OWN) sees only patients in their own appointments/queue; none exist before SC-2B.
    if (grantOf(req) === 'OWN') throw notFound();
    const p = await prisma.patient.findFirst({ where: { id: uuidParam(req, 'id'), clinicId: req.clinic!.clinicId } });
    if (!p) throw notFound();
    res.json({ ...view(p), visits: [] });
  }));

  search.get('/', ...read, h(async (req, res) => {
    const { q } = parse(PatientSearchQuery, req.query);
    const ctx = req.clinic!;
    if (grantOf(req) === 'OWN') return res.json({ patients: [] });
    const clinic = await prisma.clinic.findFirstOrThrow({ where: { id: ctx.clinicId }, select: { defaultPhoneRegion: true } });
    const digits = q.replace(/\D/g, '');
    const or: Prisma.PatientWhereInput[] = [{ nameNormalized: { contains: normalizeName(q) } }];
    if (/^\d{4}$/.test(q)) or.push({ phoneLast4: q });
    const phone = digits.length >= 6 ? parsePhone(q, clinic.defaultPhoneRegion) : null;
    if (phone) or.push({ phoneE164: phone });
    const rows = await prisma.patient.findMany({ where: { clinicId: ctx.clinicId, anonymizedAt: null, OR: or }, orderBy: { createdAt: 'desc' }, take: 50 });
    res.json({ patients: rows.map(view) }); // bookings and queue tokens join the results in SC-2B/SC-3
  }));

  return { patients, search };
}
