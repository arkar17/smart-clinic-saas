import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSION_MATRIX, resolveGrant, type CapabilityId, type ClinicRole } from '@sc/contracts';
import { Client, PASSWORD, addMember, login, makeUser, makeWorld, prisma, resetDb, startApp, stopApp, type World } from './helpers';

let w: World;
beforeAll(startApp);
afterAll(stopApp);
beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});

/** Every SC-1 tenant route that takes a resource ID. Extended by each gate (TC-SEC-001 note). */
function tenantRoutes(x: World['B']): [string, string, unknown?][] {
  const d = x.doctor.id, s = x.service.id, c = x.closure.id, e = x.exception.id;
  return [
    ['PATCH', `/api/clinic/closures/${c}`, { startDate: '2026-12-24', endDate: '2026-12-24' }],
    ['DELETE', `/api/clinic/closures/${c}`],
    ['PATCH', `/api/services/${s}`, { name: 'Renamed' }],
    ['DELETE', `/api/services/${s}`],
    ['PUT', `/api/services/${s}/doctors`, { doctorIds: [] }],
    ['PATCH', `/api/doctors/${d}`, { displayName: 'Renamed' }],
    ['PUT', `/api/doctors/${d}/availability`, { days: [] }],
    ['GET', `/api/doctors/${d}/exceptions`],
    ['POST', `/api/doctors/${d}/exceptions`, { exceptionDate: '2026-11-10', kind: 'UNAVAILABLE' }],
    ['DELETE', `/api/doctors/${d}/exceptions/${e}`],
    ['GET', `/api/doctors/${d}/schedule?from=2026-11-02&to=2026-11-03`],
  ];
}

describe('strict tenant isolation (TC-SEC-001, TC-SEC-002, TC-SEC-012)', () => {
  it('TC-SEC-001: clinic A admin gets 404 with identical bodies for every clinic B resource; B is unchanged', async () => {
    const admin = await login('admin.a@example.test');
    for (const [method, path, body] of tenantRoutes(w.B)) {
      const r = await admin.req(method, path, body);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.body.error.code).toBe('NOT_FOUND');
      expect(r.body.error.message).toBe('Not found.');
    }
    const staffB = await prisma.clinicMember.findFirstOrThrow({ where: { clinicId: w.B.clinic.id, userId: w.adminB.id } });
    for (const p of ['PATCH', 'POST'] as const) {
      const r = p === 'PATCH' ? await admin.patch(`/api/staff/${staffB.id}`, { roles: ['DOCTOR'] }) : await admin.post(`/api/staff/${staffB.id}/deactivate`);
      expect(r.status).toBe(404);
    }
    expect(await prisma.clinicService.count({ where: { clinicId: w.B.clinic.id } })).toBe(1);
    expect(await prisma.clinicClosure.count({ where: { clinicId: w.B.clinic.id } })).toBe(1);
    expect((await prisma.clinicMember.findFirstOrThrow({ where: { id: staffB.id } })).isActive).toBe(true);
    // Lists never include the other clinic's rows.
    for (const p of ['/api/services', '/api/doctors', '/api/staff', '/api/clinic/closures']) {
      expect(JSON.stringify((await admin.get(p)).body), p).not.toMatch(new RegExp(`${w.B.service.id}|${w.B.doctor.id}|${w.B.closure.id}|admin\\.b@`));
    }
  });

  it('TC-SEC-001 / TC-STF-004: dual-membership user with A selected cannot reach B resources', async () => {
    const u = await login('dual.user@example.test', PASSWORD, w.A.clinic.id);
    for (const [method, path, body] of tenantRoutes(w.B).filter(([m]) => m === 'GET')) {
      expect((await u.req(method, path, body)).status, path).toBe(404);
    }
    expect((await u.get(`/api/doctors/${w.mDualB.doctor!.id}/exceptions`)).status).toBe(404);
  });

  it('TC-SEC-002: a Platform Administrator session cannot use tenant endpoints; platform list is metadata only', async () => {
    const pa = await login('platform.admin@example.test');
    for (const path of ['/api/clinic/profile', '/api/services', '/api/doctors', '/api/staff', `/api/doctors/${w.A.doctor.id}/schedule?from=2026-11-02&to=2026-11-02`]) {
      expect([403, 404]).toContain((await pa.get(path, { 'x-clinic-id': w.A.clinic.id })).status);
    }
    const list = await pa.get('/api/platform/clinics');
    expect(list.status).toBe(200);
    expect(Object.keys(list.body.items[0]).sort()).toEqual(['activatedAt', 'activeMembershipCount', 'createdAt', 'id', 'name', 'slug', 'status', 'statusReason', 'timezone']);
    const staff = await login('admin.a@example.test');
    expect((await staff.get('/api/platform/clinics')).status).toBe(403);
  });

  it('TC-SEC-012: the database rejects cross-clinic references (composite FK, 23503)', async () => {
    await expect(prisma.$executeRaw`INSERT INTO doctor_service (clinic_id, doctor_id, service_id) VALUES (${w.A.clinic.id}::uuid, ${w.B.doctor.id}::uuid, ${w.A.service.id}::uuid)`).rejects.toThrow(/doctor_service_doctor_fkey|23503/);
    await expect(prisma.$executeRaw`INSERT INTO doctor (clinic_id, display_name, member_id) VALUES (${w.A.clinic.id}::uuid, 'Dr. Cross', ${w.mDualB.member.id}::uuid)`).rejects.toThrow(/doctor_member_fkey|23503/);
    await expect(prisma.$executeRaw`INSERT INTO doctor_availability (clinic_id, doctor_id, weekday, start_min, end_min) VALUES (${w.A.clinic.id}::uuid, ${w.B.doctor.id}::uuid, 2, 540, 600)`).rejects.toThrow(/doctor_availability_doctor_fkey|23503/);
  });
});

describe('staff role authorization (TC-SEC-003, TC-SEC-004, TC-SEC-016)', () => {
  it('TC-SEC-003: receptionist write calls on settings, services, schedules and staff → 403', async () => {
    const rec = await login('reception.a@example.test');
    const calls: [string, string, unknown][] = [
      ['PATCH', '/api/clinic/settings', { holdMinutes: 12 }],
      ['PATCH', '/api/clinic/profile', { name: 'Changed' }],
      ['PUT', '/api/clinic/business-hours', { days: [] }],
      ['POST', '/api/services', { name: 'X ray', durationMin: 15, onlineBookingEnabled: true, walkInEnabled: true }],
      ['PUT', `/api/doctors/${w.A.doctor.id}/availability`, { days: [] }],
      ['POST', '/api/staff', { email: 'x@example.test', displayName: 'Xx', roles: ['RECEPTIONIST'] }],
    ];
    for (const [m, p, b] of calls) expect((await rec.req(m, p, b)).status, `${m} ${p}`).toBe(403);
  });

  it("TC-SEC-004: doctor X cannot read doctor Y's schedule or exceptions", async () => {
    const doc = await login('doctor.a@example.test');
    expect((await doc.get(`/api/doctors/${w.mDocA.doctor!.id}/schedule?from=2026-11-02&to=2026-11-02`)).status).toBe(200);
    expect((await doc.get(`/api/doctors/${w.A.doctor.id}/schedule?from=2026-11-02&to=2026-11-02`)).status).toBe(404);
    expect((await doc.get(`/api/doctors/${w.A.doctor.id}/exceptions`)).status).toBe(404);
    expect((await doc.post(`/api/doctors/${w.mDocA.doctor!.id}/exceptions`, { exceptionDate: '2026-11-10', kind: 'UNAVAILABLE' })).status).toBe(403);
  });

  it('TC-SEC-016: matrix test — each SC-1 capability endpoint × staff role matches PERMISSION_MATRIX_v1.1.csv', async () => {
    const own = w.mDocA.doctor!.id;
    const spare = await addMember(w.A.clinic.id, (await makeUser('spare.a@example.test')).id, ['RECEPTIONIST']); // CAP-CLN-09 target
    // Invalid/empty bodies: an allowed call reaches validation (2xx/422); a denied call stops at 403. Nothing is mutated.
    const endpoints: { cap: CapabilityId; mode: 'read' | 'write'; method: string; path: string }[] = [
      { cap: 'CAP-CLN-01', mode: 'write', method: 'PATCH', path: '/api/clinic/settings' },
      { cap: 'CAP-CLN-02', mode: 'read', method: 'GET', path: '/api/clinic/business-hours' },
      { cap: 'CAP-CLN-02', mode: 'write', method: 'PUT', path: '/api/clinic/business-hours' },
      { cap: 'CAP-CLN-04', mode: 'read', method: 'GET', path: '/api/services' },
      { cap: 'CAP-CLN-04', mode: 'write', method: 'POST', path: '/api/services' },
      { cap: 'CAP-CLN-05', mode: 'read', method: 'GET', path: `/api/doctors/${own}/exceptions` },
      { cap: 'CAP-CLN-05', mode: 'write', method: 'POST', path: `/api/doctors/${own}/exceptions` },
      { cap: 'CAP-CLN-07', mode: 'write', method: 'POST', path: '/api/staff' },
      { cap: 'CAP-CLN-09', mode: 'write', method: 'POST', path: `/api/staff/${spare.member.id}/reset-password` },
      { cap: 'CAP-STF-01', mode: 'write', method: 'POST', path: '/api/auth/change-password' },
      { cap: 'CAP-STF-02', mode: 'write', method: 'POST', path: '/api/auth/select-clinic' },
    ];
    const users: Record<ClinicRole, string> = { CLINIC_ADMIN: 'admin.a@example.test', RECEPTIONIST: 'reception.a@example.test', DOCTOR: 'doctor.a@example.test' };
    for (const [role, email] of Object.entries(users) as [ClinicRole, string][]) {
      const c = await login(email);
      for (const e of endpoints) {
        const expected = PERMISSION_MATRIX[e.cap][role];
        const allowed = resolveGrant(e.cap, [role], e.mode) !== null || (e.cap.startsWith('CAP-STF') && expected !== 'DENY');
        const body = e.cap === 'CAP-CLN-09' ? {} : { invalid: true };
        const r = e.method === 'GET' ? await c.get(e.path) : await c.req(e.method, e.path, e.cap === 'CAP-CLN-09' ? undefined : body);
        if (e.cap === 'CAP-CLN-09' && allowed) {
          expect(r.status, `${role} ${e.cap}`).toBe(200);
          continue;
        }
        expect(r.status === 403, `${role} ${e.cap} ${e.method} ${e.path} → ${r.status} (matrix ${expected})`).toBe(!allowed);
      }
    }
    // Platform capabilities: PLATFORM_ADMIN only.
    const pa = await login('platform.admin@example.test');
    const admin = await login('admin.a@example.test');
    for (const [cap, path] of [['CAP-PLT-03', '/api/platform/clinics'], ['CAP-PLT-06', '/api/platform/users?email=admin.a@example.test']] as const) {
      expect(PERMISSION_MATRIX[cap].PLATFORM_ADMIN).toBe('ALLOW');
      expect((await pa.get(path)).status).toBe(200);
      expect((await admin.get(path)).status).toBe(403);
    }
    for (const path of ['/api/platform/clinics', `/api/platform/clinics/${w.A.clinic.id}/suspend`, `/api/platform/users/${w.recA.id}/password-reset`, `/api/platform/users/${w.recA.id}/deactivate`]) {
      expect((await admin.post(path, { invalid: true })).status, path).toBe(403);
      expect((await pa.post(path, { invalid: true })).status, path).toBe(422);
    }
    expect(new Client()).toBeDefined();
  });
});
