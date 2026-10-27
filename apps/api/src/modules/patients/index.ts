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
    const ctx = req.clinic!;
    const id = uuidParam(req, 'id');
    // DR (ALLOW_OWN): only patients with an appointment for the doctor's own profile.
    const own: Prisma.PatientWhereInput = grantOf(req) === 'OWN' ? { appointments: { some: { doctorId: ctx.doctorId ?? undefined } } } : {};
    if (grantOf(req) === 'OWN' && !ctx.doctorId) throw notFound();
    const p = await prisma.patient.findFirst({ where: { id, clinicId: ctx.clinicId, ...own } });
    if (!p) throw notFound();
    // FR-PAT-005 operational visit history (queue visits join in SC-3).
    const visits = await prisma.appointment.findMany({
      where: { clinicId: ctx.clinicId, patientId: p.id, status: { notIn: ['PENDING', 'EXPIRED'] }, ...(grantOf(req) === 'OWN' ? { doctorId: ctx.doctorId! } : {}) },
      include: { service: { select: { name: true } }, doctor: { select: { displayName: true } } }, orderBy: { startAt: 'desc' }, take: 100,
    });
    res.json({ ...view(p), visits: visits.map((v) => ({ appointmentId: v.id, date: v.serviceDate.toISOString().slice(0, 10), startAt: v.startAt, service: v.service.name, doctor: v.doctor.displayName, source: v.channel, status: v.status, bookingReference: v.bookingReference })) });
  }));

  search.get('/', ...read, h(async (req, res) => {
    const { q } = parse(PatientSearchQuery, req.query);
    const ctx = req.clinic!;
    if (grantOf(req) === 'OWN' && !ctx.doctorId) return res.json({ patients: [], appointments: [] });
    const own = grantOf(req) === 'OWN' ? { doctorId: ctx.doctorId! } : {};
    const clinic = await prisma.clinic.findFirstOrThrow({ where: { id: ctx.clinicId }, select: { defaultPhoneRegion: true } });
    const digits = q.replace(/\D/g, '');
    const or: Prisma.PatientWhereInput[] = [{ nameNormalized: { contains: normalizeName(q) } }];
    if (/^\d{4}$/.test(q)) or.push({ phoneLast4: q });
    const phone = digits.length >= 6 ? parsePhone(q, clinic.defaultPhoneRegion) : null;
    if (phone) or.push({ phoneE164: phone });
    const rows = await prisma.patient.findMany({
      where: { clinicId: ctx.clinicId, anonymizedAt: null, OR: or, ...(grantOf(req) === 'OWN' ? { appointments: { some: own } } : {}) },
      orderBy: { createdAt: 'desc' }, take: 50,
    });
    // BR-020: booking references are searchable by staff (queue tokens join in SC-3).
    const ref = /^SC-?[0-9A-Z]{8}$/i.test(q) ? `SC-${q.replace(/^SC-?/i, '').toUpperCase()}` : null;
    const appointments = ref
      ? await prisma.appointment.findMany({ where: { clinicId: ctx.clinicId, bookingReference: ref, ...own }, select: { id: true, bookingReference: true, status: true, startAt: true, patientId: true } })
      : [];
    res.json({ patients: rows.map(view), appointments });
  }));

  return { patients, search };
}
