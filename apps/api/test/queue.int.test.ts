import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, PASSWORD, baseUrl, clock, deps, login, makeUser, makeWorld, prisma, resetDb, startApp, stopApp, type World } from './helpers';
import { closeDays } from '../src/modules/queue/index';

let w: World;
beforeAll(startApp);
afterAll(stopApp);
beforeEach(async () => {
  await resetDb();
  w = await makeWorld(); // Monday 2026-11-02 10:00 Asia/Bangkok; clinic 09–12, 13–18; doctor A 09–17
  await prisma.clinic.update({ where: { id: w.A.clinic.id }, data: { walkinEnabled: true, walkinDailyCapacity: 100 } });
});

const at = (local: string, date = '2026-11-02') => new Date(`${date}T${local}+07:00`);
const phone = (i: number) => `081${String(2000000 + i).padStart(7, '0')}`;
const join = (c: Client, i: number, extra: Record<string, unknown> = {}) =>
  c.post('/api/public/clinics/clinic-a/walk-ins', { serviceId: w.A.service.id, doctorId: w.A.doctor.id, fullName: `Walk Fictional ${String.fromCharCode(65 + (i % 26))}`, phone: phone(i), privacyAccepted: true, ...extra });
const tokenOf = (privateUrl: string) => privateUrl.split('/q/')[1]!;
const status = (raw: string) => new Client().get('/api/public/queue-entry', { 'x-access-token': raw });
const staffWalkIn = (c: Client, i: number, extra: Record<string, unknown> = {}) =>
  c.post('/api/queue/walk-ins', { serviceId: w.A.service.id, doctorId: w.A.doctor.id, fullName: `Desk Fictional ${String.fromCharCode(65 + (i % 26))}`, phone: phone(500 + i), ...extra });
const tokens = async (clinicId = w.A.clinic.id) => (await prisma.queueEntry.findMany({ where: { clinicId }, orderBy: { tokenNumber: 'asc' } })).map((e) => e.tokenNumber);
async function confirmedAppointment(local: string, i: number, doctorId = w.A.doctor.id) {
  const patient = await prisma.patient.create({ data: { clinicId: w.A.clinic.id, fullName: `Appt Fictional ${i}`, nameNormalized: `appt fictional ${i}`, phoneE164: `+6689${String(1000000 + i)}`, source: 'STAFF' } });
  return prisma.appointment.create({ data: { clinicId: w.A.clinic.id, doctorId, serviceId: w.A.service.id, patientId: patient.id, channel: 'STAFF', status: 'CONFIRMED', serviceDate: new Date('2026-11-02T00:00:00Z'), startAt: at(local), endAt: new Date(at(local).getTime() + 15 * 60_000), bookingReference: `SC-${String(10000000 + i).slice(0, 8).replace(/[ILOU]/g, '0')}`, confirmedAt: clock.now() } });
}

describe('QR walk-in registration (TC-QUE-001, -002, -005, -012, -019, -025, TC-VAL-004)', () => {
  it('TC-QUE-001 / TC-QUE-005: REGISTERED with token and private link; not in the line until arrival is confirmed', async () => {
    const r = await join(new Client(), 1);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ token: '001', status: 'REGISTERED' });
    expect(r.body.privateUrl).toMatch(/\/c\/clinic-a\/q\/[A-Za-z0-9_-]{43}$/);
    const raw = tokenOf(r.body.privateUrl);
    expect((await status(raw)).body).toMatchObject({ token: '001', status: 'REGISTERED', peopleAhead: null });
    const doc = await login('doctor.a@example.test');
    expect((await doc.post(`/api/queue/entries/${r.body.queueEntryId}/confirm-arrival`, {})).status).toBe(403); // TC-QUE-026
    const admin = await login('admin.a@example.test');
    expect((await admin.post(`/api/queue/entries/${r.body.queueEntryId}/call`, { reason: 'Out of order' })).body.error.code).toBe('INVALID_TRANSITION');
    const rec = await login('reception.a@example.test');
    const ok = await rec.post(`/api/queue/entries/${r.body.queueEntryId}/confirm-arrival`, {});
    expect(ok.body.queueEntry).toMatchObject({ status: 'WAITING' });
    expect(ok.body.queueEntry.arrivedAt).toBe(clock.now().toISOString());
    expect((await status(raw)).body).toMatchObject({ status: 'WAITING', peopleAhead: 0 });
  });

  it('TC-VAL-004: missing/invalid name or phone or a bypass field → 422 and nothing is created', async () => {
    for (const extra of [{ phone: '' }, { phone: '12' }, { fullName: 'A' }, { noPhoneReason: 'none' }, { privacyAccepted: false }]) {
      expect((await join(new Client(), 2, extra)).status, JSON.stringify(extra)).toBe(422);
    }
    expect(await prisma.queueEntry.count()).toBe(0);
    expect(await prisma.queueCounter.count()).toBe(0);
  });

  it('TC-QUE-002: closed day, after cutoff, paused and disabled are refused with a specific reason and consume no token', async () => {
    const rec = await login('reception.a@example.test');
    expect((await rec.req('PUT', '/api/clinic/walk-in-pause')).body.paused).toBe(true);
    expect((await join(new Client(), 3)).body.error).toMatchObject({ code: 'REGISTRATION_CLOSED', details: { reason: 'PAUSED' } });
    expect((await new Client().get('/api/public/clinics/clinic-a')).body.walkIn.state).toBe('PAUSED');
    await rec.del('/api/clinic/walk-in-pause');
    clock.set(at('17:00:00'));
    expect((await join(new Client(), 3)).body.error.details.reason).toBe('AFTER_CUTOFF');
    clock.set(at('10:00:00'));
    await prisma.clinicClosure.create({ data: { clinicId: w.A.clinic.id, startDate: new Date('2026-11-02T00:00:00Z'), endDate: new Date('2026-11-02T00:00:00Z'), label: 'Fictional holiday' } });
    expect((await join(new Client(), 3)).body.error.details.reason).toBe('CLOSED_TODAY');
    await prisma.clinic.update({ where: { id: w.A.clinic.id }, data: { walkinEnabled: false } });
    expect((await join(new Client(), 3)).body.error.details.reason).toBe('DISABLED');
    expect((await new Client().get('/api/public/clinics/clinic-a/walk-in/eligibility')).body).toMatchObject({ eligible: false, reason: 'DISABLED' });
    expect(await prisma.queueEntry.count()).toBe(0);
    expect((await prisma.queueCounter.findFirst())?.lastToken ?? 0).toBe(0);
  });

  it('TC-QUE-019: closes 60 min before 18:00 — 16:59:59 succeeds, 17:00:00 refused; registration during the lunch break succeeds', async () => {
    clock.set(at('12:30:00'));
    expect((await join(new Client(), 4)).status).toBe(201);
    clock.set(at('16:59:59'));
    expect((await join(new Client(), 5)).status).toBe(201);
    clock.set(at('17:00:00'));
    expect((await join(new Client(), 6)).body.error.code).toBe('REGISTRATION_CLOSED');
  });

  it('TC-QUE-012 / TC-QUE-025: a phone with an active entry cannot QR-register again (no link leaked); staff walk-in with that phone works', async () => {
    expect((await join(new Client(), 7)).status).toBe(201);
    const dup = await join(new Client(), 7, { fullName: 'Other Fictional' });
    expect(dup.body.error.code).toBe('DUPLICATE_ACTIVE_REGISTRATION');
    expect(JSON.stringify(dup.body)).not.toMatch(/\/q\/|token|queueEntryId/i);
    const rec = await login('reception.a@example.test');
    expect((await rec.post('/api/queue/walk-ins', { serviceId: w.A.service.id, doctorId: w.A.doctor.id, fullName: 'Sibling Fictional', phone: phone(7) })).status).toBe(201);
    expect((await join(new Client(), 7)).body.error.code).toBe('DUPLICATE_ACTIVE_REGISTRATION');
  });
});

describe('capacity and token allocation under concurrency (TC-QUE-003, -004, -016, -027, -013)', () => {
  it('TC-QUE-003: capacity 10 with 9 used — 20 parallel registrations → exactly 1 succeeds, 19 CAPACITY_REACHED', async () => {
    await prisma.clinic.update({ where: { id: w.A.clinic.id }, data: { walkinDailyCapacity: 10 } });
    await prisma.queueCounter.create({ data: { clinicId: w.A.clinic.id, serviceDate: new Date('2026-11-02T00:00:00Z'), walkInCount: 9 } });
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => join(new Client(), 100 + i)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.body?.error?.code === 'CAPACITY_REACHED')).toHaveLength(19);
  });

  it('TC-QUE-004: 50 parallel registrations get tokens exactly 1..50', async () => {
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => join(new Client(), 200 + i)));
    expect(rs.filter((r) => r.status !== 201).map((r) => r.body)).toEqual([]);
    expect(await tokens()).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('TC-QUE-016: over capacity a receptionist needs a reason and the entry starts WAITING', async () => {
    await prisma.clinic.update({ where: { id: w.A.clinic.id }, data: { walkinDailyCapacity: 1 } });
    const rec = await login('reception.a@example.test');
    expect((await staffWalkIn(rec, 1)).body.queueEntry.status).toBe('WAITING');
    expect((await staffWalkIn(rec, 2)).body.error.code).toBe('OVERRIDE_REASON_REQUIRED');
    const over = await staffWalkIn(rec, 2, { overrideReason: 'Fictional urgent walk-in' });
    expect(over.status).toBe(201);
    expect(over.body.privateUrl).toBeNull();
    expect((await join(new Client(), 9)).body.error.code).toBe('CAPACITY_REACHED');
  });

  it('TC-QUE-027: 30 parallel mixed creations (QR, staff walk-in, check-in) → tokens 1..30 and counter = max token', async () => {
    const appts = await Promise.all(Array.from({ length: 10 }, (_, i) => confirmedAppointment(`${String(13 + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}:00`, i)));
    const rec = await login('reception.a@example.test');
    const rs = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => join(new Client(), 300 + i)),
      ...Array.from({ length: 10 }, (_, i) => staffWalkIn(rec, 30 + i)),
      ...appts.map((a) => rec.post(`/api/appointments/${a.id}/check-in`, { overrideReason: 'Fictional early arrival' })),
    ]);
    expect(rs.filter((r) => r.status >= 300).map((r) => r.body)).toEqual([]);
    expect(await tokens()).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect((await prisma.queueCounter.findFirstOrThrow({ where: { clinicId: w.A.clinic.id } })).lastToken).toBe(30);
  });

  it('TC-QUE-013: Bangkok and London sequences are independent and restart at each clinic’s local midnight', async () => {
    await prisma.clinic.update({ where: { id: w.B.clinic.id }, data: { walkinEnabled: true, walkinDailyCapacity: 100 } });
    clock.set('2026-11-02T10:00:00Z'); // 17:00 Bangkok (closed for walk-in), 10:00 London
    const adminA = await login('admin.a@example.test');
    const adminB = await login('admin.b@example.test');
    const walkInB = (i: number) => adminB.post('/api/queue/walk-ins', { serviceId: w.B.service.id, doctorId: w.B.doctor.id, fullName: `London Fictional ${String.fromCharCode(65 + i)}`, phone: `+447400${String(100000 + i)}` });
    const b1 = await walkInB(1);
    expect(b1.body.queueEntry?.token, JSON.stringify(b1.body)).toBe('001');
    clock.set('2026-11-02T04:00:00Z'); // 11:00 Bangkok
    expect((await staffWalkIn(adminA, 1)).body.queueEntry.token).toBe('001');
    expect((await staffWalkIn(adminA, 2)).body.queueEntry.token).toBe('002');
    clock.set('2026-11-16T02:30:00Z'); // two Mondays later, 09:30 Bangkok: new clinic-local day
    expect((await staffWalkIn(await login('admin.a@example.test'), 3)).body.queueEntry.token).toBe('001');
    clock.set('2026-11-02T16:59:00Z'); // 23:59 Bangkok Monday, 16:59 London Monday: London still on day 1
    const adminB2 = await login('admin.b@example.test');
    const b2 = await adminB2.post('/api/queue/walk-ins', { serviceId: w.B.service.id, doctorId: w.B.doctor.id, fullName: 'London Fictional Late', phone: '+447400100099' });
    expect(b2.body.queueEntry.token).toBe('002'); // same London day, independent of Bangkok's sequence
    expect(await tokens(w.B.clinic.id)).toEqual([1, 2]);
  });
});

describe('doctor workflow (TC-QUE-006, -007, -008, -010, -023, -024, TC-DOC-004)', () => {
  async function waiting(n: number) {
    const rec = await login('reception.a@example.test');
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      clock.advanceMinutes(1);
      ids.push((await staffWalkIn(rec, 60 + i)).body.queueEntry.id);
    }
    return { rec, ids };
  }

  it('TC-QUE-006 / TC-QUE-010: call next takes the BR-060 head; start, complete; busy doctor → DOCTOR_BUSY', async () => {
    const { ids } = await waiting(3);
    const admin = await login('admin.a@example.test');
    const call = await admin.post(`/api/queue/doctors/${w.A.doctor.id}/call-next`, {});
    expect(call.body.queueEntry).toMatchObject({ id: ids[0], status: 'CALLED' });
    expect((await admin.post(`/api/queue/entries/${ids[0]}/start`, {})).body.queueEntry.status).toBe('IN_CONSULTATION');
    expect((await admin.post(`/api/queue/doctors/${w.A.doctor.id}/call-next`, {})).body.error.code).toBe('DOCTOR_BUSY');
    expect((await admin.post(`/api/queue/entries/${ids[0]}/complete`, {})).body.queueEntry.status).toBe('COMPLETED');
    expect((await admin.post(`/api/queue/doctors/${w.A.doctor.id}/call-next`, {})).body.queueEntry.id).toBe(ids[1]);
    const rec = await login('reception.a@example.test');
    expect((await rec.post(`/api/queue/doctors/${w.A.doctor.id}/call-next`, {})).status).toBe(403); // CAP-QUE-06 RC denied
  });

  it('TC-QUE-007: concurrent call next from two devices → one 200, one 409', async () => {
    await waiting(8);
    const a1 = await login('admin.a@example.test');
    const a2 = await login('admin.a@example.test');
    for (let run = 0; run < 5; run++) {
      await prisma.queueEntry.updateMany({ where: { status: 'CALLED' }, data: { status: 'CANCELLED' } });
      const rs = await Promise.all([a1, a2].map((c) => c.post(`/api/queue/doctors/${w.A.doctor.id}/call-next`, {})));
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await prisma.queueEntry.count({ where: { doctorId: w.A.doctor.id, status: 'CALLED' } })).toBe(1);
    }
  });

  it('TC-QUE-008 / TC-QUE-024: invalid transitions → 409; 4th return → RECALL_LIMIT_REACHED; sort time unchanged', async () => {
    const { ids } = await waiting(1);
    const admin = await login('admin.a@example.test');
    expect((await admin.post(`/api/queue/entries/${ids[0]}/start`, {})).body.error.code).toBe('INVALID_TRANSITION');
    const sort = (await prisma.queueEntry.findFirstOrThrow({ where: { id: ids[0] } })).sortTime!.toISOString();
    for (let i = 0; i < 3; i++) {
      await admin.post(`/api/queue/doctors/${w.A.doctor.id}/call-next`, {});
      expect((await admin.post(`/api/queue/entries/${ids[0]}/return-to-waiting`, {})).status).toBe(200);
      expect((await prisma.queueEntry.findFirstOrThrow({ where: { id: ids[0] } })).sortTime!.toISOString()).toBe(sort);
    }
    await admin.post(`/api/queue/doctors/${w.A.doctor.id}/call-next`, {});
    expect((await admin.post(`/api/queue/entries/${ids[0]}/return-to-waiting`, {})).body.error.code).toBe('RECALL_LIMIT_REACHED');
    await admin.post(`/api/queue/entries/${ids[0]}/start`, {});
    await admin.post(`/api/queue/entries/${ids[0]}/complete`, {});
    expect((await admin.post(`/api/queue/entries/${ids[0]}/return-to-waiting`, {})).body.error.code).toBe('INVALID_TRANSITION');
    await expect(prisma.$executeRaw`UPDATE queue_entry SET status = 'WAITING' WHERE id = ${ids[0]}::uuid`).rejects.toThrow(/invalid queue transition/); // TC-SEC-014
  });

  it('TC-QUE-023: after reassignment to doctor Y, doctor X cannot act on the entry', async () => {
    await prisma.doctorService.create({ data: { clinicId: w.A.clinic.id, doctorId: w.mDocA.doctor!.id, serviceId: w.A.service.id } });
    await prisma.doctorAvailability.create({ data: { clinicId: w.A.clinic.id, doctorId: w.mDocA.doctor!.id, weekday: 1, startMin: 540, endMin: 1020 } });
    const rec = await login('reception.a@example.test');
    const e = (await rec.post('/api/queue/walk-ins', { serviceId: w.A.service.id, doctorId: w.mDocA.doctor!.id, fullName: 'Moved Fictional', phone: phone(90) })).body.queueEntry;
    const docX = await login('doctor.a@example.test');
    expect((await docX.post(`/api/queue/doctors/${w.mDocA.doctor!.id}/call-next`, {})).body.queueEntry.id).toBe(e.id);
    expect((await docX.post(`/api/queue/entries/${e.id}/return-to-waiting`, {})).status).toBe(200);
    const moved = await rec.post(`/api/queue/entries/${e.id}/reassign`, { doctorId: w.A.doctor.id });
    expect(moved.body.queueEntry).toMatchObject({ doctorId: w.A.doctor.id, token: e.token, sortTime: e.sortTime });
    const [start, call] = await Promise.all([docX.post(`/api/queue/entries/${e.id}/start`, {}), docX.post(`/api/queue/doctors/${w.A.doctor.id}/call-next`, {})]);
    expect([start.status, call.status]).toEqual([404, 404]);
    expect((await prisma.queueEntry.findFirstOrThrow({ where: { id: e.id } })).status).toBe('WAITING');
  });

  it('TC-DOC-004: one account with doctor profiles in A and B operates only the selected clinic’s own profile', async () => {
    const dual = await makeUser('dual.doctor@example.test');
    const inA = await prisma.clinicMember.create({ data: { clinicId: w.A.clinic.id, userId: dual.id, roles: ['DOCTOR'] } });
    await prisma.doctor.update({ where: { id: w.A.doctor.id }, data: { memberId: inA.id } });
    const inB = await prisma.clinicMember.create({ data: { clinicId: w.B.clinic.id, userId: dual.id, roles: ['DOCTOR'] } });
    await prisma.doctor.update({ where: { id: w.B.doctor.id }, data: { memberId: inB.id } });
    const rec = await login('reception.a@example.test');
    await staffWalkIn(rec, 70);
    const u = await login('dual.doctor@example.test', PASSWORD, w.A.clinic.id);
    expect((await u.post(`/api/queue/doctors/${w.A.doctor.id}/call-next`, {})).status).toBe(200);
    expect((await u.post(`/api/queue/doctors/${w.B.doctor.id}/call-next`, {})).status).toBe(404);
    await u.post('/api/auth/select-clinic', { clinicId: w.B.clinic.id });
    expect((await u.post(`/api/queue/doctors/${w.A.doctor.id}/call-next`, {})).status).toBe(404);
    expect((await u.post(`/api/queue/doctors/${w.B.doctor.id}/call-next`, {})).status).toBe(204); // B line empty
    expect((await u.get('/api/queue/today')).body.entries).toEqual([]);
  });
});

describe('scheduled check-in and lifecycle sync (TC-APT-012, -013, -024, TC-QUE-011, TC-NFR-004)', () => {
  it('TC-APT-012: check-in sets CHECKED_IN and allocates one WAITING token; a second check-in is refused; the booking page shows the token', async () => {
    const a = await confirmedAppointment('10:30:00', 1);
    const raw = 'B'.repeat(43);
    await prisma.publicAccessToken.create({ data: { clinicId: w.A.clinic.id, purpose: 'BOOKING', tokenHash: (await import('../src/infra/crypto')).sha256(raw), appointmentId: a.id, expiresAt: new Date('2026-11-09T00:00:00Z') } });
    const rec = await login('reception.a@example.test');
    const [r1, r2] = await Promise.all([rec.post(`/api/appointments/${a.id}/check-in`, {}), rec.post(`/api/appointments/${a.id}/check-in`, {})]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const ok = r1.status === 200 ? r1 : r2;
    expect(ok.body).toMatchObject({ appointment: { status: 'CHECKED_IN' }, queueEntry: { token: '001', status: 'WAITING' } });
    expect(await prisma.queueEntry.count({ where: { appointmentId: a.id } })).toBe(1);
    const entry = await prisma.queueEntry.findFirstOrThrow({ where: { appointmentId: a.id } });
    expect(entry.sortTime!.toISOString()).toBe(at('10:30:00').toISOString()); // max(now, start)
    expect((await new Client().get('/api/public/booking', { 'x-access-token': raw })).body.queue).toMatchObject({ token: '001', status: 'WAITING' });
    const late = await confirmedAppointment('15:00:00', 2);
    expect((await rec.post(`/api/appointments/${late.id}/check-in`, {})).body.error.code).toBe('OVERRIDE_REASON_REQUIRED');
  });

  it('TC-APT-024: completing the queue entry completes the appointment; no-show of a scheduled entry cancels it with the reason', async () => {
    const admin = await login('admin.a@example.test');
    const a = await confirmedAppointment('10:15:00', 3);
    const b = await confirmedAppointment('10:45:00', 4);
    await admin.post(`/api/appointments/${a.id}/check-in`, {});
    await admin.post(`/api/appointments/${b.id}/check-in`, {});
    const first = (await admin.post(`/api/queue/doctors/${w.A.doctor.id}/call-next`, {})).body.queueEntry;
    await admin.post(`/api/queue/entries/${first.id}/start`, {});
    await admin.post(`/api/queue/entries/${first.id}/complete`, {});
    expect((await prisma.appointment.findFirstOrThrow({ where: { id: first.appointmentId } })).status).toBe('COMPLETED');
    const second = (await admin.post(`/api/queue/doctors/${w.A.doctor.id}/call-next`, {})).body.queueEntry;
    await admin.post(`/api/queue/entries/${second.id}/no-show`, { reason: 'Did not answer the call' });
    expect(await prisma.appointment.findFirstOrThrow({ where: { id: second.appointmentId } })).toMatchObject({ status: 'CANCELLED', cancelReason: 'Did not answer the call' });
  });

  it('TC-APT-013 / TC-QUE-011 / TC-NFR-004: day close finalises every state; running it twice concurrently gives the same result', async () => {
    const rec = await login('reception.a@example.test');
    const admin = await login('admin.a@example.test');
    const appt = await confirmedAppointment('11:00:00', 5);
    expect((await rec.post(`/api/appointments/${appt.id}/no-show`, {})).body.error.code).toBe('INVALID_TRANSITION'); // before grace
    const reg = (await join(new Client(), 400)).body.queueEntryId;
    const wait = (await staffWalkIn(rec, 80)).body.queueEntry.id;
    clock.advanceMinutes(1);
    const inCons = (await staffWalkIn(rec, 81)).body.queueEntry.id;
    await prisma.queueEntry.update({ where: { id: inCons }, data: { sortTime: new Date('2026-11-02T00:00:00Z') } });
    await admin.post(`/api/queue/doctors/${w.A.doctor.id}/call-next`, {});
    await admin.post(`/api/queue/entries/${inCons}/start`, {});
    clock.set('2026-11-02T17:01:00Z'); // 00:01 Tuesday Bangkok
    await Promise.all([closeDays(prisma, clock.now()), closeDays(prisma, clock.now())]);
    const snap = async () => Object.fromEntries((await prisma.queueEntry.findMany()).map((e) => [e.id, [e.status, e.endReason, e.autoClosed, e.version]]));
    const first = await snap();
    expect(first[reg]![0]).toBe('EXPIRED');
    expect(first[wait]).toEqual(['CANCELLED', 'SYSTEM_DAY_CLOSE', false, 1]);
    expect(first[inCons]!.slice(0, 3)).toEqual(['COMPLETED', null, true]);
    expect((await prisma.appointment.findFirstOrThrow({ where: { id: appt.id } })).status).toBe('NO_SHOW');
    await closeDays(prisma, clock.now());
    expect(await snap()).toEqual(first);
  });
});

describe('patient status and leaving (TC-QUE-014, -017, -020, -028)', () => {
  it('TC-QUE-014: the status payload holds only own token, status, doctor, now serving and people ahead', async () => {
    const rec = await login('reception.a@example.test');
    await staffWalkIn(rec, 1);
    const r = await join(new Client(), 2);
    await rec.post(`/api/queue/entries/${r.body.queueEntryId}/confirm-arrival`, {});
    const admin = await login('admin.a@example.test');
    await admin.post(`/api/queue/doctors/${w.A.doctor.id}/call-next`, {});
    const s = await status(tokenOf(r.body.privateUrl));
    expect(s.body).toMatchObject({ token: '002', status: 'WAITING', nowServingToken: '001', peopleAhead: 1, canLeave: true });
    expect(Object.keys(s.body).sort()).toEqual(['canLeave', 'clinic', 'doctor', 'nowServingToken', 'peopleAhead', 'status', 'statusText', 'token']);
    expect(JSON.stringify(s.body)).not.toMatch(/Walk Fictional|Desk Fictional|\+66|081|patient|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('TC-QUE-028 / TC-QUE-020: leaving within 10 min releases capacity; staff cancel needs a reason', async () => {
    await prisma.clinic.update({ where: { id: w.A.clinic.id }, data: { walkinDailyCapacity: 2 } });
    const a = await join(new Client(), 10);
    const b = await join(new Client(), 11);
    expect((await join(new Client(), 12)).body.error.code).toBe('CAPACITY_REACHED');
    const leave = await new Client().post('/api/public/queue-entry/leave', {}, { 'x-access-token': tokenOf(a.body.privateUrl) });
    expect(leave.body.status).toBe('CANCELLED');
    expect(await prisma.queueEntry.findFirstOrThrow({ where: { id: a.body.queueEntryId } })).toMatchObject({ cancelledBy: 'PATIENT', arrivedAt: null, sortTime: null });
    expect((await join(new Client(), 12)).status).toBe(201); // capacity released
    clock.advanceMinutes(11);
    await new Client().post('/api/public/queue-entry/leave', {}, { 'x-access-token': tokenOf(b.body.privateUrl) });
    expect((await join(new Client(), 13)).body.error.code).toBe('CAPACITY_REACHED'); // not released after 10 min
    const rec = await login('reception.a@example.test');
    const c = await staffWalkIn(rec, 14, { overrideReason: 'Fictional override' });
    expect((await rec.post(`/api/queue/entries/${c.body.queueEntry.id}/cancel`, {})).status).toBe(422);
    const admin = await login('admin.a@example.test');
    const called = (await admin.post(`/api/queue/doctors/${w.A.doctor.id}/call-next`, {})).body.queueEntry;
    expect(called.id).toBe(c.body.queueEntry.id);
  });
});

describe('tenant isolation of queue routes (TC-SEC-001 extended)', () => {
  it('clinic A staff get 404 for every clinic B queue entry and doctor; B is unchanged', async () => {
    await prisma.clinic.update({ where: { id: w.B.clinic.id }, data: { walkinEnabled: true, walkinDailyCapacity: 10 } });
    clock.set('2026-11-02T10:00:00Z'); // 10:00 London
    const adminB = await login('admin.b@example.test');
    const e = (await adminB.post('/api/queue/walk-ins', { serviceId: w.B.service.id, doctorId: w.B.doctor.id, fullName: 'London Fictional', phone: '+447400100055' })).body.queueEntry;
    const adminA = await login('admin.a@example.test');
    for (const path of ['confirm-arrival', 'start', 'complete', 'return-to-waiting', 'no-show', 'cancel', 'call', 'reassign']) {
      const body = path === 'cancel' || path === 'call' ? { reason: 'Cross clinic' } : path === 'reassign' ? { doctorId: w.A.doctor.id } : {};
      expect((await adminA.post(`/api/queue/entries/${e.id}/${path}`, body)).status, path).toBe(404);
    }
    expect((await adminA.post(`/api/queue/doctors/${w.B.doctor.id}/call-next`, {})).status).toBe(404);
    expect((await adminA.get('/api/queue/today')).body.entries).toEqual([]);
    expect((await adminA.get(`/api/queue/today?doctorId=${w.B.doctor.id}`)).body.entries).toEqual([]);
    expect((await prisma.queueEntry.findFirstOrThrow({ where: { id: e.id } })).version).toBe(0);
    expect([403, 404]).toContain((await (await login('platform.admin@example.test')).get('/api/queue/today', { 'x-clinic-id': w.A.clinic.id })).status);
  });
});

// ---- SSE ----
interface Stream { events: { id?: string; event: string; data: any }[]; closed: Promise<void>; close: () => void } // eslint-disable-line @typescript-eslint/no-explicit-any
async function openStream(path: string, headers: Record<string, string>): Promise<Stream & { status: number }> {
  const ctrl = new AbortController();
  const res = await fetch(baseUrl() + path, { headers, signal: ctrl.signal });
  const events: Stream['events'] = [];
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  if (res.ok && res.body) {
    void (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const f: Record<string, string> = {};
            for (const line of frame.split('\n')) { const k = line.indexOf(':'); if (k > 0) f[line.slice(0, k)] = line.slice(k + 1).trim(); }
            if (f.event) events.push({ id: f.id, event: f.event, data: JSON.parse(f.data ?? 'null') });
          }
        }
      } catch { /* aborted */ }
      resolveClosed();
    })();
  } else resolveClosed();
  return { status: res.status, events, closed, close: () => ctrl.abort() };
}
const staffHeaders = (c: Client) => ({ cookie: c.cookie, 'x-clinic-id': c.clinicId! });
const until = async (cond: () => boolean, ms = 3000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25)); return cond(); };

describe('live updates (TC-SEC-007, TC-QUE-021, TC-QUE-022, TC-STF-005 stream part)', () => {
  it('TC-SEC-007: clinic A events reach A staff and the own patient only; B staff and other patients get nothing; doctors see own only', async () => {
    const adminA = await login('admin.a@example.test');
    const adminB = await login('admin.b@example.test');
    const docA = await login('doctor.a@example.test'); // linked to a different doctor profile than w.A.doctor
    const mine = await join(new Client(), 1);
    const other = await join(new Client(), 2);
    const [sA, sB, sDoc, sMine] = await Promise.all([
      openStream('/api/staff/stream', staffHeaders(adminA)), openStream('/api/staff/stream', staffHeaders(adminB)), openStream('/api/staff/stream', staffHeaders(docA)),
      openStream('/api/public/stream', { 'x-access-token': tokenOf(mine.body.privateUrl) }),
    ]);
    expect(sMine.status).toBe(200);
    await until(() => sMine.events.length >= 1);
    const rec = await login('reception.a@example.test');
    await rec.post(`/api/queue/entries/${other.body.queueEntryId}/confirm-arrival`, {});
    expect(await until(() => sA.events.some((e) => e.data.queueEntryId === other.body.queueEntryId))).toBe(true);
    expect(await until(() => sMine.events.length >= 2)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(sB.events).toEqual([]);
    expect(sDoc.events.filter((e) => e.event !== 'queue.counter.updated')).toEqual([]);
    for (const e of sMine.events) {
      expect(e.event).toBe('status');
      expect(e.data.token).toBe('001');
      expect(JSON.stringify(e.data)).not.toContain(other.body.queueEntryId);
    }
    for (const e of sA.events) expect(JSON.stringify(e.data)).not.toMatch(/Fictional|\+66|081/);
    [sA, sB, sDoc, sMine].forEach((s) => s.close());
    expect((await openStream('/api/public/stream', { 'x-access-token': 'Z'.repeat(43) })).status).toBe(404);
    expect((await openStream('/api/staff/stream', { cookie: adminA.cookie, 'x-clinic-id': w.B.clinic.id })).status).toBe(409);
  });

  it('TC-QUE-021: reconnect with Last-Event-ID replays the missed events once', async () => {
    const admin = await login('admin.a@example.test');
    const snap = await admin.get('/api/queue/today');
    const rec = await login('reception.a@example.test');
    for (let i = 0; i < 3; i++) await staffWalkIn(rec, 20 + i);
    const s = await openStream('/api/staff/stream', { ...staffHeaders(admin), 'last-event-id': snap.body.lastEventId });
    expect(await until(() => s.events.filter((e) => e.event === 'queue.entry.created').length === 3)).toBe(true);
    const ids = s.events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    s.close();
  });

  it('TC-QUE-022 / TC-STF-005: streams close on logout, membership deactivation, clinic switch, link expiry and suspension', async () => {
    const admin = await login('admin.a@example.test');
    const dual = await login('dual.user@example.test', PASSWORD, w.A.clinic.id);
    const rec = await login('reception.a@example.test');
    const r = await join(new Client(), 5);
    const sDual = await openStream('/api/staff/stream', staffHeaders(dual));
    const sRec = await openStream('/api/staff/stream', staffHeaders(rec));
    const sPat = await openStream('/api/public/stream', { 'x-access-token': tokenOf(r.body.privateUrl) });
    const sAdmin = await openStream('/api/staff/stream', staffHeaders(admin));
    await admin.post(`/api/staff/${w.mDualA.member.id}/deactivate`);
    await sDual.closed;
    await rec.post('/api/auth/logout');
    await sRec.closed;
    clock.set('2026-11-04T00:00:00Z'); // queue link expired (day close + 24 h)
    await deps!.hub!.revalidateAll();
    await sPat.closed;
    clock.set('2026-11-02T03:00:00Z');
    const pa = await login('platform.admin@example.test');
    await pa.post(`/api/platform/clinics/${w.A.clinic.id}/suspend`, { reason: 'Fictional billing hold' });
    await sAdmin.closed;
    expect(deps!.hub!.size).toBe(0);
  });
});
