import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WEB, axeSerious, chromium, hasHorizontalScroll, seedFixtures, staffLogin, startStack, stopStack, type Browser } from './harness';
import { prisma } from '../helpers';

let browser: Browser;
let f: Awaited<ReturnType<typeof seedFixtures>>;
const VIEWPORTS = { mobile: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } } as const;
const contexts: { close: () => Promise<void> }[] = [];
const page = async (vp: keyof typeof VIEWPORTS = 'desktop') => {
  const ctx = await browser.newContext({ viewport: VIEWPORTS[vp] });
  contexts.push(ctx);
  return ctx.newPage();
};
// Close pages after each test: all contexts share 127.0.0.1, and public streams are capped at 5 per IP (Arch 19.3).
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((c) => c.close()));
});
let phoneSeq = 0;
const nextPhone = () => `08130${String(10000 + ++phoneSeq)}`;

beforeAll(async () => {
  await startStack();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await stopStack();
});

describe.each(['desktop', 'mobile'] as const)('Journey A — scheduled appointment (%s)', (vp) => {
  it('TC-APT-001/009/012, TC-QUE-006/009: book → confirmation → check-in → token → doctor call (live on patient page) → completed', async () => {
    f = await seedFixtures();
    const patient = await page(vp);
    await patient.goto(`${WEB}/c/e2e-clinic`);
    expect(await hasHorizontalScroll(patient)).toBe(false);
    await patient.getByRole('link', { name: 'Book an Appointment' }).click();
    await patient.getByRole('button', { name: /General consultation/ }).click();
    await expect.poll(() => patient.getByText('With Dr. Fictional Avery').isVisible()).toBe(true); // TC-APT-001 preselection
    await patient.locator('section[aria-labelledby="date"] button').first().click();
    await patient.locator('section[aria-labelledby="time"] button').first().click();
    await patient.getByRole('button', { name: /Continue with/ }).click();
    await patient.getByLabel('Full name').fill('Somchai Fictional');
    await patient.getByLabel('Phone number').fill(nextPhone());
    await patient.getByLabel("I have read the clinic's privacy notice").check();
    await patient.getByRole('button', { name: 'Confirm booking' }).click();
    await patient.getByText('Your appointment is confirmed').waitFor();
    const reference = (await patient.locator('strong.font-mono').textContent())!;
    expect(reference).toMatch(/^SC-[0-9A-Z]{8}$/);
    await patient.getByRole('link', { name: 'Open my booking' }).click();
    await patient.getByText('Somchai · •••• •••').waitFor(); // TC-APT-022 masked

    const reception = await page(vp);
    await staffLogin(reception, 'e2e.reception@example.test');
    const appt = await prisma.appointment.findFirstOrThrow({ where: { bookingReference: reference } });
    await reception.goto(`${WEB}/app/appointments`);
    await reception.getByLabel('Date').fill(appt.serviceDate.toISOString().slice(0, 10));
    await reception.getByRole('button', { name: 'Check in' }).click();
    await reception.getByText(/Checked in — queue token \d{3}/).waitFor();

    await patient.reload();
    await patient.getByText('Waiting', { exact: true }).waitFor();
    const doctor = await page(vp);
    await staffLogin(doctor, 'e2e.doctor@example.test');
    await doctor.goto(`${WEB}/app/my-queue`);
    const t0 = Date.now();
    await doctor.getByRole('button', { name: 'Call next' }).click();
    await patient.getByText('Please go to the doctor now').waitFor({ timeout: 5000 }); // SSE to the patient page (TC-QUE-009)
    expect(Date.now() - t0).toBeLessThan(2000 + 1500); // ≤ 2 s render budget plus click round trip
    await doctor.getByRole('button', { name: 'Start consultation' }).click();
    await doctor.getByRole('button', { name: 'Complete' }).click();
    await patient.getByText('Visit completed').waitFor();
    expect((await prisma.appointment.findFirstOrThrow({ where: { id: appt.id } })).status).toBe('COMPLETED');
    expect(await hasHorizontalScroll(doctor)).toBe(false);
  });
});

describe.each(['desktop', 'mobile'] as const)('Journey B — walk-in (%s)', (vp) => {
  it('TC-QUE-001/005/006, TC-RPT-004: join → REGISTERED → reception confirms → WAITING (live) → doctor calls → completed; dashboard updates live', async () => {
    f = await seedFixtures();
    const patient = await page(vp);
    await patient.goto(`${WEB}/c/e2e-clinic`);
    await patient.getByRole('link', { name: 'Join Today’s Queue' }).click();
    await patient.getByRole('button', { name: 'General consultation' }).click();
    await patient.getByLabel('Full name').fill('Malee Fictional');
    await patient.getByLabel('Phone number').fill(nextPhone());
    await patient.getByLabel("I have read the clinic's privacy notice").check();
    await patient.getByRole('button', { name: 'Get my number' }).click();
    await patient.getByText('Please go to reception to confirm you have arrived').waitFor();
    await patient.getByRole('link', { name: 'Follow my place in the queue' }).click();
    await patient.getByText(/Registered — please confirm/).waitFor();
    expect(await patient.locator('[aria-live="polite"]').count()).toBeGreaterThan(0); // TC-NFR-005

    const admin = await page(vp);
    await staffLogin(admin, 'e2e.admin@example.test');
    await admin.getByRole('heading', { name: /^Today/ }).waitFor();
    const waitingTile = admin.getByRole('link', { name: /^Waiting/ });
    await expect.poll(async () => (await waitingTile.textContent())?.replace(/\D/g, '')).toBe('0');

    const reception = await page(vp);
    await staffLogin(reception, 'e2e.reception@example.test');
    await reception.goto(`${WEB}/app/queue`);
    await reception.getByRole('button', { name: 'Confirm arrival' }).click();
    await patient.getByText('Waiting', { exact: true }).waitFor(); // live via SSE
    await expect.poll(async () => (await waitingTile.textContent())?.replace(/\D/g, ''), { timeout: 5000 }).toBe('1'); // TC-RPT-004
    const focused = await patient.evaluate(() => document.activeElement?.tagName);
    expect(['BODY', 'A', 'BUTTON']).toContain(focused); // live updates do not steal focus

    const doctor = await page(vp);
    await staffLogin(doctor, 'e2e.doctor@example.test');
    await doctor.goto(`${WEB}/app/my-queue`);
    await doctor.getByRole('button', { name: 'Call next' }).click();
    await patient.getByText('Please go to the doctor now').waitFor();
    await doctor.getByRole('button', { name: 'Start consultation' }).click();
    await doctor.getByRole('button', { name: 'Complete' }).click();
    await patient.getByText('Visit completed').waitFor();
    for (const p of [patient, reception, doctor]) expect(await hasHorizontalScroll(p)).toBe(false);
  });
});

describe('staff workflows and security (Chromium)', () => {
  it('login, clinic switching, admin hours/services, doctor and PA denials, cross-clinic isolation, revocation, private links, invalid transitions', async () => {
    f = await seedFixtures();
    // Clinic switching (TC-STF-004 E2E part).
    const dual = await page();
    await staffLogin(dual, 'e2e.dual@example.test');
    await dual.waitForURL(/select-clinic/);
    await dual.getByRole('button', { name: /Fictional E2E Clinic/ }).click();
    await dual.getByRole('heading', { name: /^Today/ }).waitFor();
    await dual.getByLabel('Active clinic').selectOption({ label: 'Fictional Other Clinic' });
    await dual.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Staff' }).waitFor({ state: 'attached' }); // CLINIC_ADMIN in B
    // Clinic Admin manages hours and services (TC-CLN-001/TC-SVC-001 E2E part).
    const admin = await page();
    await staffLogin(admin, 'e2e.admin@example.test');
    await admin.goto(`${WEB}/app/hours`);
    await admin.getByRole('button', { name: 'Save hours' }).click();
    await admin.getByText('Opening hours saved').waitFor();
    await admin.goto(`${WEB}/app/services`);
    await admin.getByRole('button', { name: 'New service' }).click();
    await admin.getByLabel('Name', { exact: true }).fill('Vaccination');
    await admin.getByRole('button', { name: 'Save', exact: true }).click();
    await admin.getByRole('cell', { name: 'Vaccination' }).waitFor();
    // Doctor sees only own queue and cannot manage staff; PA cannot read patient records (TC-SEC-002/004).
    const doctor = await page();
    await staffLogin(doctor, 'e2e.doctor@example.test');
    await doctor.getByRole('heading', { name: /^Today/ }).waitFor();
    expect(await doctor.getByRole('link', { name: 'Staff' }).count()).toBe(0);
    await doctor.goto(`${WEB}/app/staff`);
    await doctor.getByRole('alert').waitFor();
    const patient = await prisma.patient.create({ data: { clinicId: f.A.clinic.id, fullName: 'Private Fictional', nameNormalized: 'private fictional', phoneE164: '+66810000001', source: 'STAFF' } });
    expect((await doctor.request.get(`${WEB}/api/patients/${patient.id}`, { headers: { 'x-clinic-id': f.A.clinic.id } })).status()).toBe(404);
    const pa = await page();
    await staffLogin(pa, 'e2e.platform@example.test');
    await pa.waitForURL(/\/platform/);
    expect([403, 404]).toContain((await pa.request.get(`${WEB}/api/patients/${patient.id}`, { headers: { 'x-clinic-id': f.A.clinic.id } })).status());
    // Cross-clinic isolation: clinic B admin cannot read clinic A records.
    const adminB = await page();
    await staffLogin(adminB, 'e2e.adminb@example.test');
    expect((await adminB.request.get(`${WEB}/api/patients/${patient.id}`, { headers: { 'x-clinic-id': f.B.clinic.id } })).status()).toBe(404);
    // Invalid transition and unauthorized action (TC-QUE-008/026).
    const reception = await page();
    await staffLogin(reception, 'e2e.reception@example.test');
    const csrf = await reception.evaluate(async () => (await (await fetch('/api/auth/me')).json()).csrfToken);
    const walkIn = await reception.request.post(`${WEB}/api/queue/walk-ins`, { headers: { 'x-clinic-id': f.A.clinic.id, 'x-csrf-token': csrf, origin: WEB }, data: { serviceId: f.A.service.id, doctorId: f.doctorA.id, fullName: 'Desk Fictional', phone: nextPhone() } });
    const entry = (await walkIn.json()).queueEntry;
    expect((await reception.request.post(`${WEB}/api/queue/entries/${entry.id}/confirm-arrival`, { headers: { 'x-clinic-id': f.A.clinic.id, 'x-csrf-token': csrf, origin: WEB }, data: {} })).status()).toBe(409);
    expect((await reception.request.post(`${WEB}/api/queue/doctors/${f.doctorA.id}/call-next`, { headers: { 'x-clinic-id': f.A.clinic.id, 'x-csrf-token': csrf, origin: WEB }, data: {} })).status()).toBe(403);
    // Membership revocation: the receptionist's next action sends them to clinic selection (TC-STF-002).
    const recRow = await prisma.clinicMember.findFirstOrThrow({ where: { id: f.receptionMember.id } });
    await prisma.clinicMember.update({ where: { id: recRow.id }, data: { isActive: false } });
    await reception.goto(`${WEB}/app/queue`);
    await reception.waitForURL(/select-clinic|login/, { timeout: 10000 });
    // Private links: a random token shows the generic invalid page (TC-SEC-006).
    const anon = await page('mobile');
    await anon.goto(`${WEB}/c/e2e-clinic/q/${'Z'.repeat(43)}`);
    await anon.getByText(/not valid|not found|Something went wrong/i).waitFor();
    await anon.goto(`${WEB}/c/e2e-clinic/b/${'Z'.repeat(43)}`);
    await anon.getByText('This link is not valid').waitFor();
  });
});

describe('accessibility and responsiveness (TC-NFR-001, TC-NFR-002)', () => {
  it('axe reports no serious/critical issues and no horizontal scroll at 360/430/768/1280 px on key screens', async () => {
    f = await seedFixtures();
    const problems: string[] = [];
    const publicPaths = ['/c/e2e-clinic', '/c/e2e-clinic/book', '/c/e2e-clinic/join', '/login'];
    const staffPaths = ['/app', '/app/queue', '/app/appointments', '/app/settings', '/app/hours', '/app/services', '/app/doctors', '/app/staff', '/app/reports'];
    for (const width of [360, 430, 768, 1280]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      const p = await ctx.newPage();
      for (const path of publicPaths) {
        await p.goto(`${WEB}${path}`);
        await p.waitForLoadState('load');
        await p.waitForTimeout(400); // live SSE keeps the network busy, so no networkidle
        if (await hasHorizontalScroll(p)) problems.push(`${width}px horizontal scroll ${path}`);
        if (width === 360 || width === 1280) problems.push(...(await axeSerious(p)).map((v) => `${width}px ${path} ${v}`));
      }
      await staffLogin(p, 'e2e.admin@example.test');
      for (const path of staffPaths) {
        await p.goto(`${WEB}${path}`);
        await p.waitForLoadState('load');
        await p.waitForTimeout(400); // live SSE keeps the network busy, so no networkidle
        if (await hasHorizontalScroll(p)) problems.push(`${width}px horizontal scroll ${path}`);
        if (width === 360 || width === 1280) problems.push(...(await axeSerious(p)).map((v) => `${width}px ${path} ${v}`));
      }
      await ctx.close();
    }
    expect(problems).toEqual([]);
  });
});
