import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clock, login, makeWorld, prisma, resetDb, startApp, stopApp, type World } from './helpers';

let w: World;
beforeAll(startApp);
afterAll(stopApp);
beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});

const min = (n: number) => n * 60_000;
let tokenSeq = 0;
async function entry(clinic: World['A'], date: string, opts: { status: string; source?: string; sortAt?: string; waitMin?: number; consultMin?: number; autoClosed?: boolean; doctorId?: string; appointmentId?: string }) {
  const d = new Date(`${date}T00:00:00Z`);
  await prisma.$executeRaw`INSERT INTO queue_counter (clinic_id, service_date) VALUES (${clinic.clinic.id}::uuid, ${d}) ON CONFLICT DO NOTHING`;
  const patient = await prisma.patient.create({ data: { clinicId: clinic.clinic.id, fullName: `Report Fictional ${++tokenSeq}`, nameNormalized: `report fictional ${tokenSeq}`, phoneE164: `+66812${String(100000 + tokenSeq)}`, source: 'STAFF' } });
  const sort = new Date(opts.sortAt ?? `${date}T03:00:00Z`);
  const called = opts.waitMin !== undefined ? new Date(sort.getTime() + min(opts.waitMin)) : null;
  const started = called && opts.consultMin !== undefined ? called : null;
  const source = opts.source ?? (opts.appointmentId ? 'SCHEDULED' : 'STAFF_WALK_IN');
  const registered = opts.status === 'REGISTERED' || opts.status === 'EXPIRED' || (opts.status === 'CANCELLED' && !opts.waitMin && source === 'QR_WALK_IN');
  return prisma.queueEntry.create({
    data: {
      clinicId: clinic.clinic.id, serviceDate: d, tokenNumber: tokenSeq, doctorId: opts.doctorId ?? clinic.doctor.id, serviceId: clinic.service.id, patientId: patient.id,
      appointmentId: opts.appointmentId ?? null, source: source as 'SCHEDULED', status: opts.status as 'COMPLETED', countsTowardCapacity: source !== 'SCHEDULED',
      arrivedAt: registered ? null : sort, sortTime: registered ? null : sort, firstCalledAt: called, lastCalledAt: called, startedAt: started,
      completedAt: started && opts.consultMin !== undefined ? new Date(started.getTime() + min(opts.consultMin)) : null, autoClosed: opts.autoClosed ?? false,
    },
  });
}
async function appointment(date: string, status: string, extra: Record<string, unknown> = {}) {
  const patient = await prisma.patient.create({ data: { clinicId: w.A.clinic.id, fullName: `Appt Fictional ${++tokenSeq}`, nameNormalized: `appt fictional ${tokenSeq}`, phoneE164: `+66813${String(100000 + tokenSeq)}`, source: 'STAFF' } });
  const start = new Date(`${date}T03:${String(tokenSeq % 60).padStart(2, '0')}:00Z`);
  return prisma.appointment.create({ data: {
    clinicId: w.A.clinic.id, doctorId: w.A.doctor.id, serviceId: w.A.service.id, patientId: status === 'CANCELLED_HOLD' ? null : patient.id, channel: 'PUBLIC',
    status: (status === 'CANCELLED_HOLD' ? 'CANCELLED' : status) as 'CONFIRMED', serviceDate: new Date(`${date}T00:00:00Z`), startAt: start, endAt: new Date(start.getTime() + min(1)),
    bookingReference: status === 'CANCELLED_HOLD' ? null : `SC-${String(tokenSeq).padStart(8, '0')}`, confirmedAt: status === 'CANCELLED_HOLD' ? null : start, ...extra,
  } });
}
const summary = async (from: string, to: string, who = 'admin.a@example.test') => (await (await login(who)).get(`/api/reports/summary?from=${from}&to=${to}`));

describe('reports (TC-RPT-001, -002, -003, -005, -006)', () => {
  it('TC-RPT-001: median, p90 and max waiting time and consultation duration match hand calculation; auto_closed excluded', async () => {
    for (const [wait, consult] of [[5, 10], [10, 20], [15, 30], [20, 40]]) await entry(w.A, '2026-10-20', { status: 'COMPLETED', waitMin: wait, consultMin: consult });
    await entry(w.A, '2026-10-20', { status: 'COMPLETED', waitMin: 300, consultMin: 600, autoClosed: true });
    const r = (await summary('2026-10-20', '2026-10-20')).body;
    expect(r.waitingTime.overall).toEqual({ count: 4, medianMin: 12.5, p90Min: 18.5, maxMin: 20 });
    expect(r.consultationDuration.overall).toEqual({ count: 4, medianMin: 25, p90Min: 37, maxMin: 40 });
    expect(r.completedVisits.total).toBe(5);
    expect(r.completedVisits.bySource).toEqual({ STAFF_WALK_IN: 5 });
  });

  it('TC-RPT-002 / TC-RPT-006: cancellation, no-show and expired rates across a month boundary; queue no-shows are not appointment no-shows; abandoned holds excluded', async () => {
    clock.set('2026-11-02T03:00:00Z');
    await appointment('2026-10-31', 'COMPLETED');
    await appointment('2026-10-31', 'CANCELLED', { cancelledBy: 'PATIENT', cancelledAt: new Date() });
    await appointment('2026-11-01', 'NO_SHOW');
    await appointment('2026-11-01', 'CANCELLED', { cancelledBy: 'STAFF', cancelledAt: new Date() });
    await appointment('2026-11-01', 'CANCELLED_HOLD', { cancelledBy: 'PATIENT', cancelledAt: new Date() }); // AT-04: never confirmed
    const checkedIn = await appointment('2026-11-01', 'CANCELLED', { cancelledBy: 'SYSTEM', checkedInAt: new Date(), cancelReason: 'NO_SHOW' }); // AT-11
    await entry(w.A, '2026-11-01', { status: 'NO_SHOW', appointmentId: checkedIn.id, waitMin: 3 });
    await entry(w.A, '2026-10-31', { status: 'EXPIRED', source: 'QR_WALK_IN' });
    await entry(w.A, '2026-11-01', { status: 'COMPLETED', source: 'QR_WALK_IN', waitMin: 1, consultMin: 1 });
    await entry(w.A, '2026-11-01', { status: 'CANCELLED', source: 'QR_WALK_IN' });
    await entry(w.A, '2026-11-01', { status: 'EXPIRED', source: 'QR_WALK_IN' });
    const r = (await summary('2026-10-31', '2026-11-01')).body;
    expect(r.appointments).toEqual({ confirmed: 5, cancelledByPatient: 1, cancelledByStaff: 1, cancellationRate: 0.4, noShows: 1, noShowRate: 0.2 });
    expect(r.queue).toEqual({ qrRegistrations: 4, expiredRegistrations: 2, expiredRegistrationRate: 0.5, noShows: 1, cancellations: 1 });
    expect(r.completedVisits.byDay).toEqual({ '2026-11-01': 1 });
    expect((await summary('2026-10-01', '2026-12-30')).status).toBe(422); // > 90 days
  });

  it('TC-RPT-005: Europe/London DST — daily buckets use clinic-local dates (25-hour 25 Oct) and durations use instants', async () => {
    await entry(w.B, '2026-10-25', { status: 'COMPLETED', sortAt: '2026-10-25T00:30:00Z', waitMin: 90, consultMin: 15 }); // 01:30 BST → 01:00 GMT window
    await entry(w.B, '2026-10-25', { status: 'COMPLETED', sortAt: '2026-10-25T23:30:00Z', waitMin: 10, consultMin: 5 }); // 23:30 GMT, still 25 Oct local
    await entry(w.B, '2026-10-26', { status: 'COMPLETED', sortAt: '2026-10-26T00:10:00Z', waitMin: 20, consultMin: 5 });
    const r = (await summary('2026-10-25', '2026-10-26', 'admin.b@example.test')).body;
    expect(r.timezone).toBe('Europe/London');
    expect(r.completedVisits.byDay).toEqual({ '2026-10-25': 2, '2026-10-26': 1 });
    expect(r.waitingTime.overall).toEqual({ count: 3, medianMin: 20, p90Min: 76, maxMin: 90 });
  });

  it('TC-RPT-003: clinic A reports and CSV contain only clinic A data and no names or phones; receptionist and PA denied', async () => {
    await entry(w.A, '2026-10-20', { status: 'COMPLETED', waitMin: 5, consultMin: 5 });
    await entry(w.B, '2026-10-20', { status: 'COMPLETED', waitMin: 50, consultMin: 50 });
    const admin = await login('admin.a@example.test');
    expect((await admin.get('/api/reports/summary?from=2026-10-20&to=2026-10-20')).body.completedVisits.total).toBe(1);
    const csv = await admin.raw('/api/reports/summary.csv?from=2026-10-20&to=2026-10-20');
    const text = await csv.text();
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(text).toContain('"completed_visits","total","1"');
    expect(text).not.toMatch(/Report Fictional|Appt Fictional|\+66|\+44|@/);
    expect((await (await login('reception.a@example.test')).get('/api/reports/summary?from=2026-10-20&to=2026-10-20')).status).toBe(403);
    expect([403, 404]).toContain((await (await login('platform.admin@example.test')).get('/api/reports/summary?from=2026-10-20&to=2026-10-20', { 'x-clinic-id': w.A.clinic.id })).status);
  });
});

describe('Today dashboard (FR-RPT-001) and patient search (TC-PAT-002)', () => {
  it('shows counts per doctor, capacity and longest wait; a doctor sees only the own-doctor subset', async () => {
    await prisma.clinic.update({ where: { id: w.A.clinic.id }, data: { walkinEnabled: true, walkinDailyCapacity: 20 } });
    const rec = await login('reception.a@example.test');
    const base = { serviceId: w.A.service.id, doctorId: w.A.doctor.id };
    await rec.post('/api/queue/walk-ins', { ...base, fullName: 'Dash Fictional One', phone: '0812000001' });
    clock.advanceMinutes(5);
    await rec.post('/api/queue/walk-ins', { ...base, fullName: 'Dash Fictional Two', phone: '0812000002' });
    clock.advanceMinutes(10);
    const t = (await rec.get('/api/reports/today')).body;
    expect(t.totals).toMatchObject({ WAITING: 2, CALLED: 0 });
    expect(t.queue.find((q: { doctorId: string }) => q.doctorId === w.A.doctor.id)).toMatchObject({ WAITING: 2 });
    expect(t.longestWaitMin).toBe(15);
    expect(t.walkIn).toMatchObject({ used: 2, capacity: 20, remaining: 18 });
    expect(JSON.stringify(t)).not.toMatch(/Dash Fictional|0812/);
    const doc = await login('doctor.a@example.test'); // own profile has no entries
    const d = (await doc.get('/api/reports/today')).body;
    expect(d.queue.map((q: { doctorId: string }) => q.doctorId)).toEqual([w.mDocA.doctor!.id]);
    expect(d.totals.WAITING).toBe(0);
    expect(d.walkIn).toBeNull();
    expect((await (await login('admin.b@example.test')).get('/api/reports/today')).body.totals.WAITING).toBe(0);
  });

  it('TC-PAT-002: searching “5678” returns own-clinic patients only, with visit history', async () => {
    const a = await entry(w.A, '2026-10-20', { status: 'COMPLETED', waitMin: 1, consultMin: 1 });
    await prisma.patient.update({ where: { id: a.patientId }, data: { phoneE164: '+66812345678' } });
    const b = await entry(w.B, '2026-10-20', { status: 'COMPLETED', waitMin: 1, consultMin: 1 });
    await prisma.patient.update({ where: { id: b.patientId }, data: { phoneE164: '+447400125678' } });
    const rec = await login('reception.a@example.test');
    const r = await rec.get('/api/search?q=5678');
    expect(r.body.patients.map((p: { id: string }) => p.id)).toEqual([a.patientId]);
    expect((await rec.get(`/api/patients/${a.patientId}`)).body.visits).toHaveLength(1);
  });
});
