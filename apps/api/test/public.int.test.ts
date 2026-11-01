import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, clock, login, makeWorld, prisma, resetDb, startApp, stopApp, type World } from './helpers';
import { findOrCreatePatient, validatePatientIdentity } from '../src/modules/patients/index';

let w: World;
const anon = new Client();
beforeAll(startApp);
afterAll(stopApp);
beforeEach(async () => {
  await resetDb();
  w = await makeWorld(); // now = Monday 2026-11-02 10:00 Asia/Bangkok
});
const slotsUrl = (slug: string, serviceId: string, doctorId: string, date: string) => `/api/public/clinics/${slug}/availability/slots?serviceId=${serviceId}&doctorId=${doctorId}&date=${date}`;

describe('public portal (FR-QR-004/005, FR-PLT-003)', () => {
  it('shows profile, today’s hours, walk-in state and actions; no patient data; no cookie', async () => {
    const r = await anon.get('/api/public/clinics/clinic-a');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ slug: 'clinic-a', name: 'Fictional clinic-a', timezone: 'Asia/Bangkok', today: { date: '2026-11-02', intervals: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }] } });
    expect(r.body.walkIn).toEqual({ state: 'DISABLED' });
    expect(r.body.actions.book).toEqual({ enabled: true });
    expect(r.body.actions.joinQueue.enabled).toBe(false);
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  it('closed day shows the closure label; walk-in window states; no bookable service disables booking', async () => {
    await prisma.clinicClosure.create({ data: { clinicId: w.A.clinic.id, startDate: new Date('2026-11-02T00:00:00Z'), endDate: new Date('2026-11-02T00:00:00Z'), label: 'Fictional holiday' } });
    await prisma.clinic.update({ where: { id: w.A.clinic.id }, data: { walkinEnabled: true, walkinDailyCapacity: 20 } });
    const closed = await anon.get('/api/public/clinics/clinic-a');
    expect(closed.body.today).toEqual({ date: '2026-11-02', intervals: [], closedLabel: 'Fictional holiday' });
    expect(closed.body.walkIn.state).toBe('CLOSED');
    const b = await anon.get('/api/public/clinics/clinic-b'); // London 03:00 Monday: before opening
    expect(b.body.walkIn).toEqual({ state: 'DISABLED' });
    await prisma.clinic.update({ where: { id: w.B.clinic.id }, data: { walkinEnabled: true, walkinDailyCapacity: 20 } });
    expect((await anon.get('/api/public/clinics/clinic-b')).body.walkIn).toEqual({ state: 'NOT_YET_OPEN', opensAt: '09:00', closesAt: '17:00' });
    await prisma.clinicService.updateMany({ where: { clinicId: w.A.clinic.id }, data: { onlineBookingEnabled: false } });
    expect((await anon.get('/api/public/clinics/clinic-a')).body.actions.book.enabled).toBe(false);
  });

  it('unknown, PENDING_SETUP and SUSPENDED clinics return an identical 404', async () => {
    await prisma.clinic.update({ where: { id: w.B.clinic.id }, data: { status: 'SUSPENDED', statusReason: 'Fictional hold' } });
    await prisma.clinic.create({ data: { slug: 'pending-clinic', name: 'Pending', timezone: 'Asia/Bangkok', defaultPhoneRegion: 'TH' } });
    const bodies = [];
    for (const slug of ['no-such-clinic', 'pending-clinic', 'clinic-b']) {
      const r = await anon.get(`/api/public/clinics/${slug}`);
      expect(r.status).toBe(404);
      bodies.push({ code: r.body.error.code, message: r.body.error.message });
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });
});

describe('public services and doctors (FR-APT-001, FR-APT-002)', () => {
  it('lists only active online-bookable services with active eligible doctors; preselects the only doctor', async () => {
    const extra = await prisma.doctor.create({ data: { clinicId: w.A.clinic.id, displayName: 'Dr. Fictional Second' } });
    const multi = await prisma.clinicService.create({ data: { clinicId: w.A.clinic.id, name: 'Vaccination', durationMin: 10, onlineBookingEnabled: true, walkInEnabled: false } });
    await prisma.doctorService.createMany({ data: [{ clinicId: w.A.clinic.id, doctorId: w.A.doctor.id, serviceId: multi.id }, { clinicId: w.A.clinic.id, doctorId: extra.id, serviceId: multi.id }] });
    await prisma.clinicService.create({ data: { clinicId: w.A.clinic.id, name: 'No doctor yet', durationMin: 10, onlineBookingEnabled: true, walkInEnabled: true } });
    await prisma.clinicService.create({ data: { clinicId: w.A.clinic.id, name: 'Walk-in only', durationMin: 10, onlineBookingEnabled: false, walkInEnabled: true } });
    const r = await anon.get('/api/public/clinics/clinic-a/services');
    const byName = Object.fromEntries(r.body.items.map((s: { name: string }) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual(['General consultation', 'Vaccination']);
    expect(byName['General consultation'].preselectedDoctorId).toBe(w.A.doctor.id);
    expect(byName.Vaccination.preselectedDoctorId).toBeNull();
    expect(byName.Vaccination.doctors).toHaveLength(2);
    await prisma.doctor.update({ where: { id: extra.id }, data: { isActive: false } });
    expect((await anon.get('/api/public/clinics/clinic-a/services')).body.items.find((s: { name: string }) => s.name === 'Vaccination').preselectedDoctorId).toBe(w.A.doctor.id);
    expect(JSON.stringify(r.body)).not.toMatch(/memberId|email|phone/);
  });
});

describe('public availability (FR-APT-003, FR-APT-004, BR-052)', () => {
  it('slots respect hours, breaks, minimum notice and duration in clinic time', async () => {
    const r = await anon.get(slotsUrl('clinic-a', w.A.service.id, w.A.doctor.id, '2026-11-02'));
    expect(r.status).toBe(200);
    const local = r.body.slots.map((s: { startAt: string }) => new Date(s.startAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }));
    expect(local[0]).toBe('11:00'); // now 10:00 + 60 min notice
    expect(local).not.toContain('12:00'); // clinic lunch break
    expect(local[local.length - 1]).toBe('16:45'); // doctor ends 17:00, 15-min service
    expect(r.body.slots[0]).toEqual({ startAt: '2026-11-02T04:00:00.000Z', endAt: '2026-11-02T04:15:00.000Z' });
  });

  it('dates within the horizon exclude doctor exceptions, closures and non-working days', async () => {
    const r = await anon.get(`/api/public/clinics/clinic-a/availability/dates?serviceId=${w.A.service.id}&doctorId=${w.A.doctor.id}`);
    expect(r.body.dates).toEqual(['2026-11-02', '2026-11-16', '2026-11-23', '2026-11-30']); // Mondays; 11-09 UNAVAILABLE
    await prisma.clinic.update({ where: { id: w.A.clinic.id }, data: { horizonDays: 7 } });
    expect((await anon.get(`/api/public/clinics/clinic-a/availability/dates?serviceId=${w.A.service.id}&doctorId=${w.A.doctor.id}`)).body.dates).toEqual(['2026-11-02']);
    expect((await anon.get(slotsUrl('clinic-a', w.A.service.id, w.A.doctor.id, '2026-11-16'))).body.slots).toEqual([]);
    expect((await anon.get(slotsUrl('clinic-a', w.A.service.id, w.A.doctor.id, '2026-11-01'))).body.slots).toEqual([]); // past
    clock.set('2026-11-02T10:30:00Z'); // 17:30 local: notice pushes past the doctor's end
    expect((await anon.get(slotsUrl('clinic-a', w.A.service.id, w.A.doctor.id, '2026-11-02'))).body.slots).toEqual([]);
  });

  it('refuses ineligible doctors and non-bookable services; foreign IDs are 404 (isolation)', async () => {
    const other = await prisma.doctor.create({ data: { clinicId: w.A.clinic.id, displayName: 'Dr. Fictional Ineligible' } });
    expect((await anon.get(slotsUrl('clinic-a', w.A.service.id, other.id, '2026-11-02'))).body.error.code).toBe('DOCTOR_NOT_ELIGIBLE');
    await prisma.clinicService.update({ where: { id: w.A.service.id }, data: { onlineBookingEnabled: false } });
    expect((await anon.get(slotsUrl('clinic-a', w.A.service.id, w.A.doctor.id, '2026-11-02'))).body.error.code).toBe('SERVICE_NOT_BOOKABLE');
    expect((await anon.get(slotsUrl('clinic-a', w.B.service.id, w.B.doctor.id, '2026-11-02'))).status).toBe(404);
    expect((await anon.get(slotsUrl('clinic-b', w.A.service.id, w.A.doctor.id, '2026-11-02'))).status).toBe(404);
    expect((await anon.get(`/api/public/clinics/clinic-a/availability/slots?serviceId=${w.A.service.id}&doctorId=${w.A.doctor.id}&date=2026-11-02&clinicId=${w.B.clinic.id}`)).status).toBe(422);
  });
});

describe('patients (FR-PAT-001/002/003/006) and QR (FR-QR-001/002)', () => {
  it('find-or-create reuses within a clinic and never matches across clinics', async () => {
    const id = validatePatientIdentity({ fullName: 'Somchai Fictional', phone: '081 234 5678' }, 'TH');
    const now = clock.now();
    const a1 = await findOrCreatePatient(prisma, w.A.clinic.id, id, 'QR_BOOKING', now);
    const a2 = await findOrCreatePatient(prisma, w.A.clinic.id, validatePatientIdentity({ fullName: '  SOMCHAI   fictional ', phone: '+66812345678' }, 'TH'), 'STAFF', now);
    const sibling = await findOrCreatePatient(prisma, w.A.clinic.id, validatePatientIdentity({ fullName: 'Malee Fictional', phone: '0812345678' }, 'TH'), 'QR_BOOKING', now);
    const b1 = await findOrCreatePatient(prisma, w.B.clinic.id, id, 'QR_BOOKING', now);
    expect(a1.created).toBe(true);
    expect(a2).toMatchObject({ created: false, patient: { id: a1.patient.id } });
    expect(sibling.patient.id).not.toBe(a1.patient.id); // same phone, different name → new record
    expect(b1.created).toBe(true);
    expect(b1.patient.id).not.toBe(a1.patient.id);
    expect((await prisma.patient.findFirstOrThrow({ where: { id: a1.patient.id } })).phoneLast4).toBe('5678');
    const [x, y] = await Promise.all([1, 2].map(() => findOrCreatePatient(prisma, w.A.clinic.id, validatePatientIdentity({ fullName: 'Race Fictional', phone: '0899999999' }, 'TH'), 'QR_BOOKING', now)));
    expect(x!.patient.id).toBe(y!.patient.id);
  });

  it('staff search by name, full phone and last 4; clinic-scoped; doctor sees none; PA denied', async () => {
    const now = clock.now();
    const p = (await findOrCreatePatient(prisma, w.A.clinic.id, validatePatientIdentity({ fullName: 'Élodie Fictionné', phone: '0812345678' }, 'TH'), 'STAFF', now)).patient;
    await findOrCreatePatient(prisma, w.B.clinic.id, validatePatientIdentity({ fullName: 'Élodie Fictionné', phone: '+66812345678' }, 'GB'), 'STAFF', now);
    const rec = await login('reception.a@example.test');
    for (const q of ['elodie', 'FICTIONNE', '0812345678', '5678']) {
      const r = await rec.get(`/api/search?q=${encodeURIComponent(q)}`);
      expect(r.body.patients.map((x: { id: string }) => x.id), q).toEqual([p.id]);
    }
    expect((await rec.get(`/api/patients/${p.id}`)).body).toMatchObject({ id: p.id, fullName: 'Élodie Fictionné', phone: '+66812345678', visits: [] });
    const adminB = await login('admin.b@example.test');
    expect((await adminB.get(`/api/patients/${p.id}`)).status).toBe(404);
    expect((await (await login('doctor.a@example.test')).get('/api/search?q=elodie')).body.patients).toEqual([]);
    expect([403, 404]).toContain((await (await login('platform.admin@example.test')).get(`/api/patients/${p.id}`)).status);
    expect((await rec.get('/api/search?q=elodie&clinicId=x')).status).toBe(422);
  });

  it('QR encodes only the canonical URL; PNG ≥ 1024 px; receptionist allowed, doctor denied', async () => {
    const admin = await login('admin.a@example.test');
    const svg = await admin.raw('/api/clinic/qr.svg');
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect(svg.headers.get('x-qr-url')).toBe('http://localhost:5173/c/clinic-a?src=qr');
    const png = await (await login('reception.a@example.test')).raw('/api/clinic/qr.png');
    expect(png.headers.get('content-type')).toContain('image/png');
    const bytes = Buffer.from(await png.arrayBuffer());
    expect(bytes.readUInt32BE(16)).toBeGreaterThanOrEqual(1024); // IHDR width
    expect((await (await login('doctor.a@example.test')).raw('/api/clinic/qr.svg')).status).toBe(403);
  });
});
