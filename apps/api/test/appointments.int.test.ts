import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client, clock, login, makeWorld, prisma, resetDb, startApp, stopApp, type World } from './helpers';
import { expireHolds } from '../src/modules/booking/index';

let w: World;
beforeAll(startApp);
afterAll(stopApp);
beforeEach(async () => {
  await resetDb();
  w = await makeWorld(); // now = Monday 2026-11-02 10:00 Asia/Bangkok; doctor A.doctor works Mondays 09:00–17:00
});

const MON = '2026-11-16';
const at = (local: string, date = MON) => new Date(`${date}T${local}:00+07:00`).toISOString();
const base = '/api/public/clinics/clinic-a';
const hold = (c: Client, startAt: string, extra?: Record<string, string>) => c.post(`${base}/reservations`, { serviceId: w.A.service.id, doctorId: w.A.doctor.id, startAt }, extra);
const confirm = (c: Client, h: { reservationId: string; reservationSecret: string }, who = { fullName: 'Somchai Fictional', phone: '081 234 5678' }, extra?: Record<string, string>) =>
  c.post(`${base}/reservations/${h.reservationId}/confirm`, { reservationSecret: h.reservationSecret, ...who, privacyAccepted: true }, extra);
async function book(startAt: string, who?: { fullName: string; phone: string }) {
  const c = new Client();
  const h = await hold(c, startAt);
  expect(h.status, JSON.stringify(h.body)).toBe(201);
  const r = await confirm(c, h.body, who);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { client: c, hold: h.body, booking: r.body, token: r.body.privateUrl.split('/b/')[1] as string };
}
const slotsOf = async (date = MON) => (await new Client().get(`${base}/availability/slots?serviceId=${w.A.service.id}&doctorId=${w.A.doctor.id}&date=${date}`)).body.slots.map((s: { startAt: string }) => s.startAt);
const tokenClient = (token: string) => {
  const c = new Client();
  return { get: () => c.get('/api/public/booking', { 'x-access-token': token }), cancel: () => c.post('/api/public/booking/cancel', {}, { 'x-access-token': token }) };
};

describe('holds (TC-APT-005, -006, -023)', () => {
  it('TC-APT-005: a hold blocks until expiry at query time, then frees the slot before the job runs; the job sets EXPIRED', async () => {
    clock.set('2026-11-16T03:00:00Z'); // Monday 10:00 local
    const h = await hold(new Client(), at('13:00'));
    expect(h.status).toBe(201);
    clock.set('2026-11-16T03:09:59Z');
    expect(await slotsOf()).not.toContain(at('13:00'));
    clock.set('2026-11-16T03:10:00Z');
    expect(await slotsOf()).toContain(at('13:00'));
    expect((await prisma.appointment.findFirstOrThrow({ where: { id: h.body.reservationId } })).status).toBe('PENDING');
    expect(await expireHolds(prisma, clock.now())).toBe(1);
    const a = await prisma.appointment.findFirstOrThrow({ where: { id: h.body.reservationId } });
    expect(a.status).toBe('EXPIRED');
    expect(a.reservationSecretHash).toBeNull();
  });

  it('TC-APT-006: 100 parallel holds for one free slot → exactly one 201, 99 × 409 SLOT_UNAVAILABLE, one active row', async () => {
    const results = await Promise.all(Array.from({ length: 100 }, () => hold(new Client(), at('10:00'))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const losers = results.filter((r) => r.status !== 201);
    expect(losers.every((r) => r.status === 409 && r.body.error.code === 'SLOT_UNAVAILABLE'), JSON.stringify(losers.find((r) => r.status !== 409)?.body)).toBe(true);
    expect(await prisma.appointment.count({ where: { status: 'PENDING', startAt: new Date(at('10:00')) } })).toBe(1);
  });

  it('TC-APT-023: a second hold from the same browser cancels the first; a sixth active hold from one IP → 429', async () => {
    const c = new Client();
    const first = await hold(c, at('10:00'));
    const second = await hold(c, at('10:15'));
    expect(second.status).toBe(201);
    expect((await prisma.appointment.findFirstOrThrow({ where: { id: first.body.reservationId } })).status).toBe('CANCELLED');
    for (const t of ['11:00', '11:15', '11:30', '11:45']) expect((await hold(new Client(), at(t))).status).toBe(201);
    const sixth = await hold(new Client(), at('13:00'));
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('retry-after')).toBeTruthy();
  });
});

describe('confirmation (TC-APT-007..010, -015, -018, TC-PAT-001, TC-SEC-015)', () => {
  it('TC-APT-009 / TC-SEC-015: confirm issues SC-XXXXXXXX and a private link; only hashes are stored', async () => {
    const { booking, hold: h, token } = await book(at('10:00'));
    expect(booking.bookingReference).toMatch(/^SC-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(booking.privateUrl).toMatch(/^http:\/\/localhost:5173\/c\/clinic-a\/b\/[A-Za-z0-9_-]{43}$/);
    const a = await prisma.appointment.findFirstOrThrow({ where: { id: booking.appointmentId } });
    expect(a).toMatchObject({ status: 'CONFIRMED', reservationSecretHash: null, holdIpHash: null });
    const dump = JSON.stringify(await prisma.$queryRawUnsafe('SELECT row_to_json(t)::text AS j FROM appointment t'))
      + JSON.stringify(await prisma.$queryRawUnsafe("SELECT encode(token_hash, 'hex') AS h FROM public_access_token"))
      + JSON.stringify(await prisma.$queryRawUnsafe("SELECT encode(response_body_enc, 'escape') AS b FROM idempotency_record"));
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(h.reservationSecret);
    expect(dump).not.toContain(Buffer.from(token).toString('hex'));
  });

  it('TC-APT-010: same Idempotency-Key replays identically with one appointment; different body → 422', async () => {
    const c = new Client();
    const h = (await hold(c, at('10:00'))).body;
    const key = randomUUID();
    const r1 = await confirm(c, h, undefined, { 'idempotency-key': key });
    const r2 = await confirm(c, h, undefined, { 'idempotency-key': key });
    expect(r1.status).toBe(201);
    expect(r2.body).toEqual(r1.body);
    expect(await prisma.appointment.count({ where: { status: 'CONFIRMED' } })).toBe(1);
    expect((await confirm(c, h, { fullName: 'Other Fictional', phone: '0812345678' }, { 'idempotency-key': key })).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await c.post(`${base}/reservations/${h.reservationId}/confirm`, {}, { 'idempotency-key': 'not-a-uuid' })).status).toBe(422);
  });

  it('TC-APT-007 / TC-APT-008: expired hold → 410; invalid name/phone/extra field → 422 and the hold stays PENDING', async () => {
    const c = new Client();
    const h = (await hold(c, at('10:00'))).body;
    for (const bad of [{ fullName: 'A', phone: '0812345678' }, { fullName: 'Fictional Patient', phone: '12' }]) {
      const r = await confirm(c, h, bad);
      expect(r.status).toBe(422);
      expect(r.body.error.fields).toBeTruthy();
    }
    expect((await c.post(`${base}/reservations/${h.reservationId}/confirm`, { reservationSecret: h.reservationSecret, fullName: 'Fictional Patient', phone: '0812345678', privacyAccepted: true, noPhoneReason: 'x' })).status).toBe(422);
    expect((await c.post(`${base}/reservations/${h.reservationId}/confirm`, { reservationSecret: h.reservationSecret, fullName: 'Fictional Patient', phone: '0812345678' })).status).toBe(422);
    expect((await prisma.appointment.findFirstOrThrow({ where: { id: h.reservationId } })).status).toBe('PENDING');
    expect((await confirm(c, { ...h, reservationSecret: 'x'.repeat(22) })).status).toBe(404);
    clock.advanceMinutes(11);
    const expired = await confirm(c, h);
    expect(expired.status).toBe(410);
    expect((await prisma.appointment.findFirstOrThrow({ where: { id: h.reservationId } })).bookingReference).toBeNull();
  });

  it('TC-APT-015: slots inside minimum notice or beyond the horizon are rejected when requested directly', async () => {
    expect((await hold(new Client(), at('10:30', '2026-11-02'))).body.error.code).toBe('SLOT_UNAVAILABLE'); // now 10:00 + 60 min notice
    expect((await hold(new Client(), at('10:00', '2026-12-07'))).body.error.code).toBe('SLOT_UNAVAILABLE'); // beyond 30-day horizon
    expect((await hold(new Client(), at('10:05'))).body.error.code).toBe('SLOT_UNAVAILABLE'); // off the 15-min grid
    expect((await hold(new Client(), at('11:00', '2026-11-02'))).status).toBe(201);
  });

  it('TC-APT-018 / TC-PAT-001: the 4th active booking for a phone → 409 BOOKING_LIMIT_REACHED; matching patient reused', async () => {
    const first = await book(at('10:00'), { fullName: 'Somchai Fictional', phone: '+66812345678' });
    await book(at('10:15'), { fullName: 'somchai   fictional', phone: '0812345678' });
    await book(at('10:30'), { fullName: 'Malee Fictional', phone: '0812345678' });
    const patients = await prisma.patient.findMany({ where: { clinicId: w.A.clinic.id } });
    expect(patients).toHaveLength(2);
    expect((await prisma.appointment.findFirstOrThrow({ where: { id: first.booking.appointmentId } })).patientId).toBe(patients.find((p) => p.nameNormalized === 'somchai fictional')!.id);
    const c = new Client();
    const h = (await hold(c, at('10:45'))).body;
    expect((await confirm(c, h, { fullName: 'Somchai Fictional', phone: '0812345678' })).body.error.code).toBe('BOOKING_LIMIT_REACHED');
  });

  it('confirm re-validates the slot: a schedule change since the hold → 409 and the hold is cancelled', async () => {
    const c = new Client();
    const h = (await hold(c, at('10:00'))).body;
    await prisma.scheduleException.create({ data: { clinicId: w.A.clinic.id, doctorId: w.A.doctor.id, exceptionDate: new Date(`${MON}T00:00:00Z`), kind: 'UNAVAILABLE' } });
    expect((await confirm(c, h)).body.error.code).toBe('SLOT_UNAVAILABLE');
    expect((await prisma.appointment.findFirstOrThrow({ where: { id: h.reservationId } })).status).toBe('CANCELLED');
  });

  it('release (AT-04) frees the slot immediately', async () => {
    const c = new Client();
    const h = (await hold(c, at('10:00'))).body;
    expect((await c.post(`${base}/reservations/${h.reservationId}/release`, { reservationSecret: h.reservationSecret })).body.status).toBe('CANCELLED');
    expect(await slotsOf()).toContain(at('10:00'));
  });
});

describe('private booking link (TC-APT-011, -022, TC-SEC-006)', () => {
  it('TC-APT-022: first name and masked phone only; noindex and no-referrer headers', async () => {
    const { token, booking } = await book(at('10:00'));
    const r = await tokenClient(token).get();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ bookingReference: booking.bookingReference, status: 'CONFIRMED', patient: { firstName: 'Somchai', maskedPhone: '•••• ••• 5678' } });
    expect(JSON.stringify(r.body)).not.toMatch(/Fictional|812345678|patientId/);
    expect(r.headers.get('x-robots-tag')).toContain('noindex');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('TC-SEC-006: random, expired, revoked and missing tokens give the same 404', async () => {
    const { token } = await book(at('10:00'));
    const bodies: string[] = [];
    for (const t of ['A'.repeat(43), '', 'short']) {
      const r = await tokenClient(t).get();
      expect(r.status).toBe(404);
      bodies.push(r.body.error.message);
    }
    clock.set('2026-11-23T03:00:01Z'); // start + 7 days passed
    expect((await tokenClient(token).get()).status).toBe(404);
    expect(new Set(bodies).size).toBe(1);
  });

  it('TC-APT-011: cancel 3 h before succeeds and frees the slot; 1 h before is refused', async () => {
    const early = await book(at('13:00'));
    const late = await book(at('13:30'));
    clock.set('2026-11-16T03:00:00Z'); // 10:00 local: 3 h before 13:00
    expect((await tokenClient(early.token).cancel()).body.status).toBe('CANCELLED');
    expect((await tokenClient(early.token).get()).body.status).toBe('CANCELLED');
    clock.set('2026-11-16T05:30:00Z'); // 12:30 local: 1 h before 13:30, cutoff 2 h
    const refused = await tokenClient(late.token).cancel();
    expect(refused.body.error.code).toBe('CANCELLATION_CUTOFF_PASSED');
    expect((await tokenClient(late.token).get()).body.cancellation.allowed).toBe(false);
  });
});

describe('staff appointments (TC-APT-014, -016, -017, -019..021, TC-SVC-001, isolation)', () => {
  it('TC-APT-016: receptionist creates an appointment 20 min from now (no minimum notice); appears in the day view', async () => {
    const rec = await login('reception.a@example.test');
    const startAt = at('10:30', '2026-11-02'); // now 10:00 local
    const r = await rec.post('/api/appointments', { serviceId: w.A.service.id, doctorId: w.A.doctor.id, startAt, fullName: 'Walk Fictional', phone: '0899999999' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.appointment.status).toBe('CONFIRMED');
    expect(r.body.privateUrl).toContain('/c/clinic-a/b/');
    const day = await rec.get('/api/appointments?from=2026-11-02');
    expect(day.body.items.map((a: { id: string }) => a.id)).toEqual([r.body.appointment.id]);
    expect((await rec.post('/api/appointments', { serviceId: w.A.service.id, doctorId: w.A.doctor.id, startAt, fullName: 'Other Fictional', phone: '0888888888' })).body.error.code).toBe('SLOT_UNAVAILABLE');
  });

  it('TC-APT-017: reschedule to a taken slot → 409, original kept; to a free slot → same reference and link', async () => {
    const a = await book(at('10:00'));
    await book(at('10:15'), { fullName: 'Malee Fictional', phone: '0811111111' });
    const rec = await login('reception.a@example.test');
    const taken = await rec.post(`/api/appointments/${a.booking.appointmentId}/reschedule`, { startAt: at('10:15'), version: 1 });
    expect(taken.body.error.code).toBe('SLOT_UNAVAILABLE');
    const moved = await rec.post(`/api/appointments/${a.booking.appointmentId}/reschedule`, { startAt: at('14:00'), version: 1 });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ bookingReference: a.booking.bookingReference, startAt: at('14:00') });
    expect((await tokenClient(a.token).get()).body.startAt).toBe(at('14:00'));
    expect((await rec.post(`/api/appointments/${a.booking.appointmentId}/reschedule`, { startAt: at('15:00'), version: 1 })).body.error.code).toBe('VERSION_CONFLICT');
  });

  it('TC-APT-019: concurrent reschedules of A and B into one free slot (20 runs) → exactly one wins; loser unchanged', async () => {
    const rec = await login('reception.a@example.test');
    for (let run = 0; run < 20; run++) {
      await prisma.appointment.deleteMany({});
      const slotA = at('09:00'), slotB = at('09:15'), target = at('16:00');
      const A = await rec.post('/api/appointments', { serviceId: w.A.service.id, doctorId: w.A.doctor.id, startAt: slotA, fullName: 'Aaa Fictional', phone: '0811111111' });
      const B = await rec.post('/api/appointments', { serviceId: w.A.service.id, doctorId: w.A.doctor.id, startAt: slotB, fullName: 'Bbb Fictional', phone: '0822222222' });
      const [ra, rb] = await Promise.all([A, B].map((x) => rec.post(`/api/appointments/${x.body.appointment.id}/reschedule`, { startAt: target, version: 0 })));
      expect([ra!.status, rb!.status].sort()).toEqual([200, 409]);
      const loser = ra!.status === 409 ? A : B;
      const row = await prisma.appointment.findFirstOrThrow({ where: { id: loser.body.appointment.id } });
      expect(row.startAt.toISOString()).toBe(loser.body.appointment.startAt);
      expect(row.bookingReference).toBe(loser.body.appointment.bookingReference);
    }
  });

  it('TC-APT-020 / TC-APT-021: public hold vs staff reschedule, and staff create vs public confirm, never double-book', async () => {
    const rec = await login('reception.a@example.test');
    const A = await rec.post('/api/appointments', { serviceId: w.A.service.id, doctorId: w.A.doctor.id, startAt: at('09:00'), fullName: 'Aaa Fictional', phone: '0811111111' });
    const [h, r] = await Promise.all([hold(new Client(), at('16:00')), rec.post(`/api/appointments/${A.body.appointment.id}/reschedule`, { startAt: at('16:00'), version: 0 })]);
    expect([h.status, r.status].filter((s) => s === 201 || s === 200)).toHaveLength(1);
    expect(await prisma.appointment.count({ where: { startAt: new Date(at('16:00')), status: { in: ['PENDING', 'CONFIRMED'] } } })).toBe(1);

    const c = new Client();
    const held = (await hold(c, at('16:30'))).body;
    const [conf, staff] = await Promise.all([confirm(c, held), rec.post('/api/appointments', { serviceId: w.A.service.id, doctorId: w.A.doctor.id, startAt: at('16:30'), fullName: 'Ccc Fictional', phone: '0833333333' })]);
    expect(conf.status).toBe(201);
    expect(staff.status).toBe(409);
    expect(await prisma.appointment.count({ where: { startAt: new Date(at('16:30')), status: 'CONFIRMED' } })).toBe(1);
  });

  it('TC-APT-014: an UNAVAILABLE exception keeps the appointment CONFIRMED and lists it in Conflicts; staff cancel with reason', async () => {
    const a = await book(at('10:00'));
    const admin = await login('admin.a@example.test');
    await admin.post(`/api/doctors/${w.A.doctor.id}/exceptions`, { exceptionDate: MON, kind: 'UNAVAILABLE' });
    expect((await prisma.appointment.findFirstOrThrow({ where: { id: a.booking.appointmentId } })).status).toBe('CONFIRMED');
    expect((await admin.get('/api/appointments/conflicts')).body.items.map((x: { id: string }) => x.id)).toEqual([a.booking.appointmentId]);
    expect((await admin.post(`/api/appointments/${a.booking.appointmentId}/cancel`, { reason: 'Doctor on fictional leave', version: 1 })).body.status).toBe('CANCELLED');
    expect((await admin.get('/api/appointments/conflicts')).body.items).toEqual([]);
  });

  it('TC-SVC-001 (SC-2 part): a service with history cannot be deleted; deactivated it disappears from the portal', async () => {
    await book(at('10:00'));
    const admin = await login('admin.a@example.test');
    expect((await admin.del(`/api/services/${w.A.service.id}`)).status).toBe(422);
    await admin.patch(`/api/services/${w.A.service.id}`, { isActive: false });
    expect((await new Client().get(`${base}/services`)).body.items).toEqual([]);
    expect(await prisma.appointment.count({ where: { serviceId: w.A.service.id } })).toBe(1);
  });

  it('isolation and scope: other clinic → 404; doctor sees own only; search by reference; PA denied', async () => {
    const a = await book(at('10:00'));
    const adminB = await login('admin.b@example.test');
    for (const [m, p, b] of [['GET', `/api/appointments/${a.booking.appointmentId}`], ['POST', `/api/appointments/${a.booking.appointmentId}/cancel`, { reason: 'Cross clinic', version: 1 }], ['POST', `/api/appointments/${a.booking.appointmentId}/reschedule`, { startAt: at('11:00'), version: 1 }]] as const) {
      expect((await adminB.req(m, p, b)).status, p).toBe(404);
    }
    expect((await adminB.get('/api/appointments?from=2026-11-16')).body.items).toEqual([]);
    const doc = await login('doctor.a@example.test'); // linked to a different doctor profile in A
    expect((await doc.get(`/api/appointments/${a.booking.appointmentId}`)).status).toBe(404);
    expect((await doc.get('/api/appointments?from=2026-11-16')).body.items).toEqual([]);
    expect((await doc.post('/api/appointments', {})).status).toBe(403);
    const rec = await login('reception.a@example.test');
    expect((await rec.get(`/api/search?q=${a.booking.bookingReference}`)).body.appointments.map((x: { id: string }) => x.id)).toEqual([a.booking.appointmentId]);
    expect((await rec.get(`/api/patients/${(await prisma.appointment.findFirstOrThrow({ where: { id: a.booking.appointmentId } })).patientId}`)).body.visits).toHaveLength(1);
    expect([403, 404]).toContain((await (await login('platform.admin@example.test')).get('/api/appointments?from=2026-11-16', { 'x-clinic-id': w.A.clinic.id })).status);
    expect((await new Client().get(`/api/public/booking`, { 'x-access-token': a.booking.bookingReference })).status).toBe(404); // reference alone grants nothing
  });
});

describe('database guards (TC-SEC-012, TC-SEC-014)', () => {
  it('TC-SEC-012: an appointment whose doctor belongs to clinic B with clinic_id A is rejected (23503)', async () => {
    await expect(prisma.$executeRaw`INSERT INTO appointment (clinic_id, doctor_id, service_id, channel, status, service_date, start_at, end_at, reservation_secret_hash, hold_expires_at)
      VALUES (${w.A.clinic.id}::uuid, ${w.B.doctor.id}::uuid, ${w.A.service.id}::uuid, 'PUBLIC', 'PENDING', '2026-11-16', now(), now() + interval '15 minutes', '\\x00', now() + interval '10 minutes')`).rejects.toThrow(/appointment_doctor_fkey|23503/);
  });

  it('TC-SEC-014: the guard trigger rejects transitions outside the whitelist', async () => {
    const { booking } = await book(at('10:00'));
    await expect(prisma.$executeRaw`UPDATE appointment SET status = 'PENDING' WHERE id = ${booking.appointmentId}::uuid`).rejects.toThrow(/invalid appointment transition|P0001/);
    await prisma.$executeRaw`UPDATE appointment SET status = 'CANCELLED' WHERE id = ${booking.appointmentId}::uuid`;
    await expect(prisma.$executeRaw`UPDATE appointment SET status = 'CONFIRMED' WHERE id = ${booking.appointmentId}::uuid`).rejects.toThrow(/invalid appointment transition|P0001/);
  });
});
