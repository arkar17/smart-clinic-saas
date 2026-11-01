import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '@sc/config';
import { createApp } from '../../src/app';
import { systemClock } from '../../src/infra/clock';
import { createLogger } from '../../src/infra/logger';
import { addMember, makeUser, prisma, resetDb } from '../helpers';

const require = createRequire(import.meta.url);
// The session provides a preinstalled Playwright + Chromium (no package install needed).
const pw = require('playwright') as typeof import('playwright');
/** E2E_BROWSER=webkit selects WebKit where it is installed (CI); Chromium otherwise. */
export const browserName = process.env.E2E_BROWSER === 'webkit' ? 'webkit' : 'chromium';
export const chromium = browserName === 'webkit' ? pw.webkit : pw.chromium;
export type Page = import('playwright').Page;
export type Browser = import('playwright').Browser;

export const API_PORT = 3101;
export const WEB_PORT = 5174;
export const WEB = `http://localhost:${WEB_PORT}`;
let api: Server | undefined;
let web: ChildProcess | undefined;
let deps: Parameters<typeof createApp>[0] | undefined;

/** Real clock; fixtures only in the guarded disposable test database (global-setup checks host and *_test). */
export async function startStack() {
  const env = loadEnv({ ...process.env, APP_ORIGIN: WEB, COOKIE_SECURE: 'false', IP_HASH_PEPPER: 'e2e-pepper-not-secret', LOG_LEVEL: 'silent', IDEMPOTENCY_ENC_KEY: Buffer.alloc(32, 9).toString('base64'), LOGIN_RATE_LIMIT_PER_10_MIN: '100000', PUBLIC_RATE_LIMIT_PER_MIN: '100000', HOLD_RATE_LIMIT_PER_MIN: '100000' });
  deps = { prisma, clock: systemClock, env, log: createLogger('silent') };
  const app = createApp(deps);
  await deps.hub!.start(env.DATABASE_URL);
  api = app.listen(API_PORT);
  const webDir = fileURLToPath(new URL('../../../web', import.meta.url));
  web = spawn('npx', ['vite', '--port', String(WEB_PORT), '--strictPort'], { cwd: webDir, env: { ...process.env, API_URL: `http://127.0.0.1:${API_PORT}` }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (await fetch(WEB).then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('web server did not start');
}
export async function stopStack() {
  web?.kill();
  await deps?.hub?.stop();
  api?.closeAllConnections?.();
  await new Promise((r) => api?.close(r));
}

export const PASSWORD = 'Fictional-Pass-2026!';
/** Fictional clinic open around the clock (UTC) so journeys work at any real time of day. */
export async function seedFixtures() {
  await resetDb();
  const allDay = Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, startMin: 0, endMin: 1440 }));
  const mk = async (slug: string, name: string) => {
    const clinic = await prisma.clinic.create({ data: { slug, name, timezone: 'UTC', defaultPhoneRegion: 'TH', status: 'ACTIVE', activatedAt: new Date(), minNoticeMin: 0, walkinEnabled: true, walkinDailyCapacity: 100, walkinClosesBeforeMin: 0, contactPhoneE164: '+6620000000' } });
    await prisma.clinicBusinessHour.createMany({ data: allDay.map((d) => ({ ...d, clinicId: clinic.id })) });
    const service = await prisma.clinicService.create({ data: { clinicId: clinic.id, name: 'General consultation', durationMin: 15, onlineBookingEnabled: true, walkInEnabled: true } });
    return { clinic, service };
  };
  const A = await mk('e2e-clinic', 'Fictional E2E Clinic');
  const B = await mk('e2e-other', 'Fictional Other Clinic');
  const users = {
    admin: await makeUser('e2e.admin@example.test'), reception: await makeUser('e2e.reception@example.test'), doctor: await makeUser('e2e.doctor@example.test'),
    dual: await makeUser('e2e.dual@example.test'), pa: await makeUser('e2e.platform@example.test', { platformAdmin: true }), adminB: await makeUser('e2e.adminb@example.test'),
  };
  await addMember(A.clinic.id, users.admin.id, ['CLINIC_ADMIN']);
  const rec = await addMember(A.clinic.id, users.reception.id, ['RECEPTIONIST']);
  const doc = await addMember(A.clinic.id, users.doctor.id, ['DOCTOR'], 'Dr. Fictional Avery');
  await addMember(A.clinic.id, users.dual.id, ['RECEPTIONIST']);
  await addMember(B.clinic.id, users.dual.id, ['CLINIC_ADMIN']);
  await addMember(B.clinic.id, users.adminB.id, ['CLINIC_ADMIN']);
  const docB = await addMember(B.clinic.id, (await makeUser('e2e.doctorb@example.test')).id, ['DOCTOR'], 'Dr. Fictional Blake');
  for (const [clinic, d] of [[A, doc.doctor!], [B, docB.doctor!]] as const) {
    await prisma.doctorAvailability.createMany({ data: allDay.map((x) => ({ ...x, clinicId: clinic.clinic.id, doctorId: d.id })) });
    await prisma.doctorService.create({ data: { clinicId: clinic.clinic.id, doctorId: d.id, serviceId: clinic.service.id } });
  }
  return { A, B, users, receptionMember: rec.member, doctorA: doc.doctor!, doctorB: docB.doctor! };
}

export async function staffLogin(page: Page, email: string) {
  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u: URL) => !u.pathname.startsWith('/login'));
}

/** TC-NFR-001: axe-core serious/critical violations on the current page. */
export async function axeSerious(page: Page) {
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const violations = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (window as any).axe.run(document, { resultTypes: ['violations'] });
    return r.violations.filter((v: { impact: string }) => v.impact === 'serious' || v.impact === 'critical').map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
  });
  return violations as string[];
}

/** TC-NFR-002: no horizontal page scroll. */
export const hasHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
