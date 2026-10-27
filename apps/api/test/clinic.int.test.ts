import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { login, makeWorld, prisma, resetDb, startApp, stopApp, type World } from './helpers';
import { verifyDatabase } from '../scripts/db-verify';

let w: World;
beforeAll(startApp);
afterAll(stopApp);
beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});

describe('clinic configuration (TC-CLN-001, TC-SCH-004, TC-VAL-003, TC-SVC-001)', () => {
  it('TC-CLN-001: invalid hours → 422 with field errors; valid hours save', async () => {
    const admin = await login('admin.a@example.test');
    const bad = await admin.put('/api/clinic/business-hours', { days: [
      { weekday: 1, closed: false, open: '18:00', close: '09:00' },
      { weekday: 2, closed: false, open: '09:00', close: '17:00', breaks: [{ start: '08:00', end: '09:30' }] },
      { weekday: 3, closed: false, open: '09:00', close: '17:00', breaks: [{ start: '12:00', end: '13:00' }, { start: '12:30', end: '13:30' }] },
    ] });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.error.fields)).toEqual(expect.arrayContaining(['days.0.close', 'days.1.breaks.0', 'days.2.breaks.1']));
    const ok = await admin.put('/api/clinic/business-hours', { days: [{ weekday: 1, closed: false, open: '09:00', close: '18:00', breaks: [{ start: '12:00', end: '13:00' }] }] });
    expect(ok.status).toBe(200);
    expect((await admin.get('/api/clinic/business-hours')).body.days[0]).toEqual({ weekday: 1, closed: false, open: '09:00', close: '18:00', breaks: [{ start: '12:00', end: '13:00' }] });
  });

  it('TC-SCH-004: a fourth break / overlapping intervals are rejected (422 and exclusion constraint)', async () => {
    const admin = await login('admin.a@example.test');
    const breaks = ['10', '11', '12', '13'].map((h) => ({ start: `${h}:00`, end: `${h}:15` }));
    expect((await admin.put(`/api/doctors/${w.A.doctor.id}/availability`, { days: [{ weekday: 1, closed: false, open: '09:00', close: '17:00', breaks }] })).status).toBe(422);
    await expect(prisma.$executeRaw`INSERT INTO doctor_availability (clinic_id, doctor_id, weekday, start_min, end_min) VALUES (${w.A.clinic.id}::uuid, ${w.A.doctor.id}::uuid, 1, 600, 660)`).rejects.toThrow(/doctor_availability_no_overlap|23P01|exclusion/);
    await expect(prisma.$executeRaw`INSERT INTO clinic_business_hour (clinic_id, weekday, start_min, end_min) VALUES (${w.A.clinic.id}::uuid, 1, 600, 660)`).rejects.toThrow(/clinic_business_hour_no_overlap|23P01|exclusion/);
  });

  it('TC-VAL-003: unknown fields → 422 on staff POSTs; strings are trimmed and NFC-normalised', async () => {
    const admin = await login('admin.a@example.test');
    for (const [p, b] of [
      ['/api/services', { name: 'Svc', durationMin: 15, onlineBookingEnabled: true, walkInEnabled: true, hacker: 1 }],
      ['/api/doctors', { displayName: 'Dr. X', role: 'admin' }],
      ['/api/clinic/closures', { startDate: '2026-12-31', endDate: '2026-12-31', clinicId: w.B.clinic.id }],
      ['/api/staff', { email: 'a@example.test', displayName: 'Ann', roles: ['DOCTOR'], isPlatformAdmin: true }],
    ] as const) expect((await admin.post(p, b)).status, p).toBe(422);
    const s = await admin.post('/api/services', { name: '  Café visit  ', durationMin: 15, onlineBookingEnabled: true, walkInEnabled: true });
    expect(s.body.name).toBe('Café visit');
  });

  it('TC-SVC-001 (SC-1 part): an unreferenced service can be deleted; deactivation keeps the row', async () => {
    const admin = await login('admin.a@example.test');
    const s = await admin.post('/api/services', { name: 'Temporary', durationMin: 10, onlineBookingEnabled: false, walkInEnabled: true });
    expect((await admin.patch(`/api/services/${w.A.service.id}`, { isActive: false })).body.isActive).toBe(false);
    expect((await admin.del(`/api/services/${s.body.id}`)).status).toBe(204);
    expect(await prisma.clinicService.count({ where: { id: w.A.service.id } })).toBe(1);
  });

  it('settings: ranges validated; walk-in requires capacity; If-Match version conflict → 409', async () => {
    const admin = await login('admin.a@example.test');
    expect((await admin.patch('/api/clinic/settings', { slotGranularityMin: 7 })).status).toBe(422);
    expect((await admin.patch('/api/clinic/settings', { walkinEnabled: true })).status).toBe(422);
    const ok = await admin.patch('/api/clinic/settings', { walkinEnabled: true, walkinDailyCapacity: 40 });
    expect(ok.status).toBe(200);
    expect((await admin.patch('/api/clinic/settings', { holdMinutes: 12 }, { 'if-match': String(ok.body.version - 1) })).body.error.code).toBe('VERSION_CONFLICT');
  });
});

describe('doctor profiles (TC-DOC-003, FR-DOC-004)', () => {
  it('TC-DOC-003: linking to an already-linked membership or one without DOCTOR is refused; other clinic impossible', async () => {
    const admin = await login('admin.a@example.test');
    expect((await admin.post('/api/doctors', { displayName: 'Dr. Dup', memberId: w.mDocA.member.id })).status).toBe(422);
    expect((await admin.post('/api/doctors', { displayName: 'Dr. NoRole', memberId: w.mRecA.member.id })).status).toBe(422);
    expect((await admin.post('/api/doctors', { displayName: 'Dr. Foreign', memberId: w.mDualB.member.id })).status).toBe(422);
    const linked = await admin.patch(`/api/doctors/${w.A.doctor.id}`, { memberId: null });
    expect(linked.status).toBe(200);
  });

  it('FR-DOC-004: doctor hours outside clinic hours are saved with a warning', async () => {
    const admin = await login('admin.a@example.test');
    const r = await admin.put(`/api/doctors/${w.A.doctor.id}/availability`, { days: [{ weekday: 1, closed: false, open: '08:00', close: '19:00', breaks: [] }] });
    expect(r.status).toBe(200);
    expect(r.body.warnings.map((x: { start: string }) => x.start)).toEqual(['08:00', '12:00', '18:00']);
    const sched = await admin.get(`/api/doctors/${w.A.doctor.id}/schedule?from=2026-11-02&to=2026-11-02`);
    expect(sched.body.days[0].bookable).toEqual([{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }]);
    expect(sched.body.days[0].bookableUtc[0].start).toBe('2026-11-02T02:00:00.000Z');
  });
});

describe('audit and schema integrity (TC-SEC-008, TC-NFR-007)', () => {
  it('TC-SEC-008: configuration changes are audited with required fields; sc_app cannot UPDATE/DELETE audit_log', async () => {
    const admin = await login('admin.a@example.test');
    await admin.patch('/api/clinic/settings', { holdMinutes: 12 });
    const ev = await prisma.auditLog.findFirstOrThrow({ where: { action: 'clinic.settings_updated' } });
    expect(ev).toMatchObject({ clinicId: w.A.clinic.id, actorType: 'STAFF', actorUserId: w.adminA.id, entityType: 'clinic', entityId: w.A.clinic.id });
    expect(ev.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await prisma.auditLog.count({ where: { action: 'auth.login', actorUserId: w.adminA.id } })).toBe(1);
    for (const sql of ['UPDATE audit_log SET action = action', 'DELETE FROM audit_log']) {
      await expect(prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE sc_app');
        await tx.$executeRawUnsafe(sql);
      })).rejects.toThrow(/permission denied/);
    }
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE sc_app');
      await tx.$executeRawUnsafe("INSERT INTO audit_log (actor_type, action, entity_type) VALUES ('SYSTEM', 'test.insert', 'test')");
    });
  });

  it('TC-NFR-007: db:verify confirms every manifest object', async () => {
    expect(await verifyDatabase(prisma)).toEqual([]);
  });
});
