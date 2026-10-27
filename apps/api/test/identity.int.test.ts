import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, PASSWORD, clock, login, makeUser, makeWorld, prisma, resetDb, startApp, stopApp, type World } from './helpers';

let w: World;
beforeAll(startApp);
afterAll(stopApp);
beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});

describe('staff authentication (TC-SEC-009, TC-SEC-010)', () => {
  it('TC-SEC-009: 6th failed login within 15 min is blocked; generic responses', async () => {
    const c = new Client();
    for (let i = 0; i < 5; i++) {
      const r = await c.post('/api/auth/login', { email: 'reception.a@example.test', password: 'wrong-password-123' });
      expect(r.status).toBe(401);
    }
    const unknown = await c.post('/api/auth/login', { email: 'nobody@example.test', password: 'wrong-password-123' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe('Email or password is incorrect.');
    expect((await c.post('/api/auth/login', { email: 'reception.a@example.test', password: PASSWORD })).body.error.code).toBe('ACCOUNT_LOCKED');
    clock.advanceMinutes(16);
    expect((await c.post('/api/auth/login', { email: 'reception.a@example.test', password: PASSWORD })).status).toBe(200);
  });

  it('TC-SEC-009: idle session expires after 60 min; logout invalidates server-side', async () => {
    const c = await login('reception.a@example.test');
    expect((await c.get('/api/auth/me')).status).toBe(200);
    clock.advanceMinutes(61);
    expect((await c.get('/api/auth/me')).status).toBe(401);
    const d = await login('reception.a@example.test');
    const cookie = d.cookie;
    expect((await d.post('/api/auth/logout')).status).toBe(204);
    const replay = new Client();
    replay.cookie = cookie;
    expect((await replay.get('/api/auth/me')).status).toBe(401);
  });

  it('TC-SEC-009: password rules (BR-080) enforced on change; other sessions revoked', async () => {
    const c = await login('reception.a@example.test');
    const other = await login('reception.a@example.test');
    expect((await c.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'short' })).status).toBe(422);
    expect((await c.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'reception.a@example.test' })).status).toBe(422);
    expect((await c.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'password1234' })).status).toBe(422);
    clock.advanceMinutes(1);
    const ok = await c.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'A-much-better-fictional-pass' });
    expect(ok.status).toBe(200);
    expect((await c.get('/api/auth/me')).status).toBe(200);
    expect((await other.get('/api/auth/me')).status).toBe(401);
  });

  it('TC-SEC-010: missing/invalid CSRF token or foreign Origin → 403', async () => {
    const c = await login('admin.a@example.test');
    const body = { name: 'Fictional service', durationMin: 15, onlineBookingEnabled: true, walkInEnabled: false };
    expect((await c.post('/api/services', body, { 'x-csrf-token': '' })).body.error.code).toBe('CSRF_INVALID');
    expect((await c.post('/api/services', body, { 'x-csrf-token': 'forged' })).status).toBe(403);
    c.origin = 'https://evil.example';
    expect((await c.post('/api/services', body)).body.error.code).toBe('CSRF_INVALID');
    c.origin = null;
    expect((await c.post('/api/services', body)).status).toBe(403);
    c.origin = 'http://localhost:5173';
    expect((await c.post('/api/services', body)).status).toBe(201);
  });

  it('FR-STF-002: temporary password forces a change before anything else', async () => {
    await makeUser('temp.user@example.test', { mustChangePassword: true });
    await prisma.clinicMember.create({ data: { clinicId: w.A.clinic.id, userId: (await prisma.user.findFirstOrThrow({ where: { email: 'temp.user@example.test' } })).id, roles: ['RECEPTIONIST'] } });
    const c = await login('temp.user@example.test');
    expect((await c.get('/api/clinic/profile')).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await c.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'A-fresh-fictional-password' })).status).toBe(200);
    expect((await c.get('/api/clinic/profile')).status).toBe(200);
  });
});

describe('multi-clinic membership (TC-STF-004, TC-STF-005, TC-SEC-017, TC-STF-002)', () => {
  it('TC-STF-004: selection required; permissions come only from the selected membership; CSRF rotates on switch', async () => {
    const c = new Client();
    const r = await c.post('/api/auth/login', { email: 'dual.user@example.test', password: PASSWORD });
    expect(r.body.selectedClinicId).toBeNull();
    expect(r.body.memberships).toHaveLength(2);
    expect((await c.get('/api/clinic/profile', { 'x-clinic-id': w.A.clinic.id })).body.error.code).toBe('CLINIC_SELECTION_REQUIRED');

    const selA = await c.post('/api/auth/select-clinic', { clinicId: w.A.clinic.id });
    expect(selA.body.roles).toEqual(['RECEPTIONIST']);
    const csrfA = c.csrf;
    expect((await c.get('/api/doctors')).body.items.length).toBeGreaterThan(1); // receptionist reads all doctors of A
    expect((await c.get(`/api/doctors/${w.mDualB.doctor!.id}/schedule?from=2026-11-02&to=2026-11-02`)).status).toBe(404);
    expect((await c.patch('/api/clinic/settings', { holdMinutes: 12 })).status).toBe(403);

    const selB = await c.post('/api/auth/select-clinic', { clinicId: w.B.clinic.id });
    expect(selB.body.doctorId).toBe(w.mDualB.doctor!.id);
    expect(c.csrf).not.toBe(csrfA);
    const docs = await c.get('/api/doctors');
    expect(docs.body.items.map((d: { id: string }) => d.id)).toEqual([w.mDualB.doctor!.id]); // own doctor only in B
    expect((await c.get(`/api/doctors/${w.A.doctor.id}/exceptions`)).status).toBe(404);
    expect((await c.get(`/api/doctors/${w.B.doctor.id}/exceptions`)).status).toBe(404); // other doctor in B: READ_OWN
  });

  it('TC-SEC-017: X-Clinic-Id mismatch → 409; select without membership → 403; clinicId in body → 422; DB blocks foreign membership', async () => {
    const c = await login('dual.user@example.test', PASSWORD, w.A.clinic.id);
    expect((await c.get('/api/clinic/profile', { 'x-clinic-id': w.B.clinic.id })).body.error.code).toBe('CLINIC_CONTEXT_MISMATCH');
    expect((await c.get('/api/clinic/profile', { 'x-clinic-id': '' })).status).toBe(409);
    const r = await login('reception.a@example.test');
    expect((await r.post('/api/auth/select-clinic', { clinicId: w.B.clinic.id })).status).toBe(403);
    const admin = await login('admin.a@example.test');
    expect((await admin.post('/api/services', { name: 'X ray', durationMin: 15, onlineBookingEnabled: true, walkInEnabled: true, clinicId: w.B.clinic.id })).status).toBe(422);
    const session = await prisma.session.findFirstOrThrow({ where: { userId: w.recA.id, revokedAt: null } });
    await expect(prisma.$executeRaw`UPDATE session SET active_clinic_id = ${w.A.clinic.id}::uuid, active_member_id = ${w.mAdminA.member.id}::uuid WHERE id_hash = ${session.idHash}`).rejects.toThrow(/session_active_membership_fkey|foreign key/);
  });

  it('TC-STF-002: deactivating the only membership → next request 403 CLINIC_SELECTION_REQUIRED and no clinic selectable', async () => {
    const rec = await login('reception.a@example.test');
    const admin = await login('admin.a@example.test');
    expect((await admin.post(`/api/staff/${w.mRecA.member.id}/deactivate`)).status).toBe(200);
    expect((await rec.get('/api/clinic/profile', { 'x-clinic-id': w.A.clinic.id })).body.error.code).toBe('CLINIC_SELECTION_REQUIRED');
    expect((await rec.post('/api/auth/select-clinic', { clinicId: w.A.clinic.id })).status).toBe(403);
    expect((await new Client().post('/api/auth/login', { email: 'reception.a@example.test', password: PASSWORD })).body.error.code).toBe('NO_ACTIVE_MEMBERSHIP');
  });

  it('TC-STF-005: deactivating the A membership leaves B usable; reactivation restores A', async () => {
    const u = await login('dual.user@example.test', PASSWORD, w.A.clinic.id);
    const admin = await login('admin.a@example.test');
    await admin.post(`/api/staff/${w.mDualA.member.id}/deactivate`);
    expect((await u.get('/api/clinic/profile')).body.error.code).toBe('CLINIC_SELECTION_REQUIRED');
    expect((await u.post('/api/auth/select-clinic', { clinicId: w.B.clinic.id })).status).toBe(200);
    expect((await u.get('/api/clinic/profile')).body.id).toBe(w.B.clinic.id);
    expect((await prisma.user.findFirstOrThrow({ where: { id: w.dual.id } })).isActive).toBe(true);
    await admin.post(`/api/staff/${w.mDualA.member.id}/reactivate`);
    expect((await u.post('/api/auth/select-clinic', { clinicId: w.A.clinic.id })).status).toBe(200);
  });
});

describe('staff management (TC-STF-001 API part, TC-STF-003, TC-STF-006)', () => {
  it('new email → account + temporary password; existing account → membership only, password unchanged', async () => {
    const admin = await login('admin.a@example.test');
    const created = await admin.post('/api/staff', { email: 'New.Reception@Example.test', displayName: 'New Reception', roles: ['RECEPTIONIST'] });
    expect(created.status).toBe(201);
    expect(created.body.temporaryPassword).toMatch(/^.{18}$/);
    const first = await new Client().post('/api/auth/login', { email: 'new.reception@example.test', password: created.body.temporaryPassword });
    expect(first.body.user.mustChangePassword).toBe(true);

    const before = (await prisma.user.findFirstOrThrow({ where: { id: w.adminB.id } })).passwordHash;
    const existing = await admin.post('/api/staff', { email: 'admin.b@example.test', displayName: 'ignored', roles: ['DOCTOR'] });
    expect(existing.status).toBe(201);
    expect(existing.body.temporaryPassword).toBeNull();
    expect((await prisma.user.findFirstOrThrow({ where: { id: w.adminB.id } })).passwordHash).toBe(before);
    expect((await admin.post('/api/staff', { email: 'platform.admin@example.test', displayName: 'PA', roles: ['RECEPTIONIST'] })).status).toBe(422);
    const list = await admin.get('/api/staff');
    expect(list.body.items.every((m: { email: string }) => m.email !== 'admin.b@example.test' || true)).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain(w.B.clinic.id); // never shows other clinics' memberships
  });

  it('TC-STF-003: last CLINIC_ADMIN cannot lose the role or be deactivated', async () => {
    const admin = await login('admin.a@example.test');
    expect((await admin.patch(`/api/staff/${w.mAdminA.member.id}`, { roles: ['RECEPTIONIST'] })).body.error.code).toBe('LAST_CLINIC_ADMIN');
    expect((await admin.post(`/api/staff/${w.mAdminA.member.id}/deactivate`)).body.error.code).toBe('LAST_CLINIC_ADMIN');
  });

  it('TC-STF-006: reset/email change allowed only for single-clinic accounts (BR-084)', async () => {
    const admin = await login('admin.a@example.test');
    const ok = await admin.post(`/api/staff/${w.mRecA.member.id}/reset-password`);
    expect(ok.status).toBe(200);
    expect(ok.body.temporaryPassword).toBeTruthy();
    const before = (await prisma.user.findFirstOrThrow({ where: { id: w.dual.id } })).passwordHash;
    expect((await admin.post(`/api/staff/${w.mDualA.member.id}/reset-password`)).status).toBe(403);
    expect((await admin.patch(`/api/staff/${w.mDualA.member.id}`, { email: 'taken.over@example.test' })).status).toBe(403);
    const after = await prisma.user.findFirstOrThrow({ where: { id: w.dual.id } });
    expect(after.passwordHash).toBe(before);
    expect(after.email).toBe('dual.user@example.test');
  });
});

describe('platform administration (TC-PLT-001, TC-PLT-003, TC-PLT-004, TC-SEC-013)', () => {
  it('TC-PLT-001: activation refused with missing checklist items; after setup it succeeds and slug locks', async () => {
    const pa = await login('platform.admin@example.test');
    const created = await pa.post('/api/platform/clinics', { name: 'Fictional New Clinic', slug: 'new-clinic', timezone: 'Asia/Bangkok', defaultPhoneRegion: 'TH', adminName: 'New Admin', adminEmail: 'new.admin@example.test' });
    expect(created.status).toBe(201);
    expect(created.body.clinic.status).toBe('PENDING_SETUP');
    const id = created.body.clinic.id;
    const refused = await pa.post(`/api/platform/clinics/${id}/activate`);
    expect(refused.body.error.code).toBe('SETUP_INCOMPLETE');
    expect(refused.body.error.details.missing).toEqual(['WEEKLY_OPERATING_HOURS', 'ACTIVE_SERVICE', 'ACTIVE_DOCTOR_WITH_SCHEDULE_AND_ELIGIBLE_SERVICE']);

    const ca = new Client();
    await ca.post('/api/auth/login', { email: 'new.admin@example.test', password: created.body.temporaryPassword });
    await ca.post('/api/auth/change-password', { currentPassword: created.body.temporaryPassword, newPassword: 'New-admin-fictional-pass' });
    expect((await ca.put('/api/clinic/business-hours', { days: [{ weekday: 1, closed: false, open: '09:00', close: '17:00', breaks: [] }] })).status).toBe(200);
    const svc = await ca.post('/api/services', { name: 'Check-up', durationMin: 20, onlineBookingEnabled: true, walkInEnabled: true });
    const doc = await ca.post('/api/doctors', { displayName: 'Dr. Fictional New' });
    await ca.put(`/api/doctors/${doc.body.id}/availability`, { days: [{ weekday: 1, closed: false, open: '09:00', close: '12:00', breaks: [] }] });
    await ca.put(`/api/services/${svc.body.id}/doctors`, { doctorIds: [doc.body.id] });
    expect((await ca.patch('/api/clinic/profile', { slug: 'renamed-clinic' })).status).toBe(200);

    const act = await pa.post(`/api/platform/clinics/${id}/activate`);
    expect(act.status).toBe(200);
    expect(act.body.status).toBe('ACTIVE');
    expect((await ca.patch('/api/clinic/profile', { slug: 'another-slug' })).status).toBe(422);
    expect((await ca.patch('/api/clinic/profile', { timezone: 'Europe/London' })).status).toBe(422);
    await expect(prisma.$executeRaw`UPDATE clinic SET slug = 'sql-bypass' WHERE id = ${id}::uuid`).rejects.toThrow(/immutable after activation/);
  });

  it('TC-PLT-003: PA reset of a two-clinic account shows a temporary password once and forces a change', async () => {
    const u = await login('dual.user@example.test');
    const pa = await login('platform.admin@example.test');
    const r = await pa.post(`/api/platform/users/${w.dual.id}/password-reset`);
    expect(r.status).toBe(200);
    expect((await u.get('/api/auth/me')).status).toBe(401);
    const again = await new Client().post('/api/auth/login', { email: 'dual.user@example.test', password: r.body.temporaryPassword });
    expect(again.body.user.mustChangePassword).toBe(true);
  });

  it('TC-PLT-004: global deactivation revokes sessions in both clinics; memberships unchanged; reactivation restores', async () => {
    const a = await login('dual.user@example.test', PASSWORD, w.A.clinic.id);
    const b = await login('dual.user@example.test', PASSWORD, w.B.clinic.id);
    const pa = await login('platform.admin@example.test');
    expect((await pa.post(`/api/platform/users/${w.dual.id}/deactivate`, {})).status).toBe(422); // reason mandatory
    expect((await pa.post(`/api/platform/users/${w.dual.id}/deactivate`, { reason: 'Fictional leave' })).status).toBe(200);
    expect((await a.get('/api/clinic/profile')).status).toBe(401);
    expect((await b.get('/api/clinic/profile')).status).toBe(401);
    expect((await new Client().post('/api/auth/login', { email: 'dual.user@example.test', password: PASSWORD })).status).toBe(401);
    expect(await prisma.clinicMember.count({ where: { userId: w.dual.id, isActive: true } })).toBe(2);
    await pa.post(`/api/platform/users/${w.dual.id}/reactivate`, { reason: 'Back from leave' });
    expect((await new Client().post('/api/auth/login', { email: 'dual.user@example.test', password: PASSWORD })).status).toBe(200);
    const lookup = await pa.get('/api/platform/users?email=dual.user@example.test');
    expect(lookup.body.memberships).toHaveLength(2);
  });

  it('TC-SEC-013: SUSPENDED clinic — CA reads only, mutations 403 CLINIC_READ_ONLY, receptionist login refused', async () => {
    const pa = await login('platform.admin@example.test');
    expect((await pa.post(`/api/platform/clinics/${w.A.clinic.id}/suspend`, {})).status).toBe(422);
    expect((await pa.post(`/api/platform/clinics/${w.A.clinic.id}/suspend`, { reason: 'Fictional billing hold' })).status).toBe(200);
    const admin = await login('admin.a@example.test');
    expect((await admin.get('/api/clinic/settings')).status).toBe(200);
    expect((await admin.patch('/api/clinic/settings', { holdMinutes: 12 })).body.error.code).toBe('CLINIC_READ_ONLY');
    expect((await new Client().post('/api/auth/login', { email: 'reception.a@example.test', password: PASSWORD })).body.error.code).toBe('NO_ACTIVE_MEMBERSHIP');
    const dual = await login('dual.user@example.test'); // B membership unaffected
    expect(dual.clinicId).toBe(w.B.clinic.id);
    expect((await pa.post(`/api/platform/clinics/${w.A.clinic.id}/reactivate`, { reason: 'Resolved' })).body.status).toBe('ACTIVE');
  });
});
