import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { loadEnv } from '@sc/config';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { createApp } from '../src/app';
import { FixedClock } from '../src/infra/clock';
import { createLogger } from '../src/infra/logger';
import { hashPassword } from '../src/modules/identity/index';

export const ORIGIN = 'http://localhost:5173';
export const PASSWORD = 'Fictional-Pass-2026!';

export const prisma = new PrismaClient();
export const clock = new FixedClock(new Date('2026-11-02T03:00:00Z')); // Monday 10:00 in Bangkok

let server: Server | undefined;
export let deps: Parameters<typeof createApp>[0] | undefined;
export const baseUrl = () => base;
let base = '';
export async function startApp() {
  const env = loadEnv({ ...process.env, IP_HASH_PEPPER: 'test-pepper-not-secret', COOKIE_SECURE: 'false', APP_ORIGIN: ORIGIN, LOG_LEVEL: 'silent', LOGIN_RATE_LIMIT_PER_10_MIN: '100000', PUBLIC_RATE_LIMIT_PER_MIN: '100000', HOLD_RATE_LIMIT_PER_MIN: '100000', TOKEN_FAILURE_LIMIT_PER_10_MIN: '100000', IDEMPOTENCY_ENC_KEY: Buffer.alloc(32, 7).toString('base64') });
  deps = { prisma, clock, env, log: createLogger('silent') };
  const app = createApp(deps);
  await deps.hub!.start(env.DATABASE_URL);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
export async function stopApp() {
  await deps?.hub?.stop();
  server?.closeAllConnections?.();
  await new Promise((r) => server?.close(r));
  await prisma.$disconnect();
}

const TABLES = ['audit_log', 'clinic_event', 'queue_entry', 'queue_counter', 'idempotency_record', 'public_access_token', 'appointment', 'patient', 'session', 'schedule_exception', 'doctor_availability', 'doctor_service', 'clinic_service', 'clinic_closure', 'clinic_business_hour', 'doctor', 'clinic_member', 'clinic', 'app_user'];
/** Destroys fixtures created by the test runner in the disposable test database only. */
export async function resetDb() {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  clock.set('2026-11-02T03:00:00Z');
}

export interface Res { status: number; body: any; headers: Headers } // eslint-disable-line @typescript-eslint/no-explicit-any

/** Minimal browser-like client: cookie jar, Origin, CSRF and X-Clinic-Id headers. */
export class Client {
  cookies: Record<string, string> = {};
  csrf = '';
  clinicId: string | null = null;
  origin: string | null = ORIGIN;

  get cookie() {
    return Object.entries(this.cookies).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  set cookie(v: string) {
    this.cookies = v ? { sc_sid: v.replace(/^sc_sid=/, '') } : {};
  }

  async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
    if (method !== 'GET' && path.startsWith('/api/public') && !('idempotency-key' in extra)) headers['idempotency-key'] = randomUUID();
    if (this.origin) headers.origin = this.origin;
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf && !('x-csrf-token' in extra)) headers['x-csrf-token'] = this.csrf;
    if (this.clinicId && !('x-clinic-id' in extra)) headers['x-clinic-id'] = this.clinicId;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const set of res.headers.getSetCookie()) {
      const [pair] = set.split(';');
      const i = pair!.indexOf('=');
      this.cookies[pair!.slice(0, i)] = pair!.slice(i + 1);
    }
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (parsed?.csrfToken) this.csrf = parsed.csrfToken;
    if (parsed && 'selectedClinicId' in parsed) this.clinicId = parsed.selectedClinicId;
    return { status: res.status, body: parsed, headers: res.headers };
  }
  /** Non-JSON responses (QR images). */
  async raw(path: string): Promise<Response> {
    const headers: Record<string, string> = { cookie: this.cookie };
    if (this.clinicId) headers['x-clinic-id'] = this.clinicId;
    return fetch(base + path, { headers });
  }
  get = (p: string, extra?: Record<string, string>) => this.req('GET', p, undefined, extra);
  post = (p: string, b: unknown = {}, extra?: Record<string, string>) => this.req('POST', p, b, extra);
  patch = (p: string, b: unknown, extra?: Record<string, string>) => this.req('PATCH', p, b, extra);
  put = (p: string, b: unknown, extra?: Record<string, string>) => this.req('PUT', p, b, extra);
  del = (p: string, extra?: Record<string, string>) => this.req('DELETE', p, undefined, extra);
}

export async function login(email: string, password = PASSWORD, clinicId?: string) {
  const c = new Client();
  const r = await c.post('/api/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.body)}`);
  if (clinicId && c.clinicId !== clinicId) {
    const s = await c.post('/api/auth/select-clinic', { clinicId });
    if (s.status !== 200) throw new Error(`select ${clinicId} failed: ${s.status}`);
  }
  return c;
}

let passwordHash: string | undefined;
export async function makeUser(email: string, opts: { platformAdmin?: boolean; mustChangePassword?: boolean; password?: string } = {}) {
  passwordHash ??= await hashPassword(PASSWORD);
  return prisma.user.create({
    data: {
      email, displayName: email.split('@')[0]!, passwordHash: opts.password ? await hashPassword(opts.password) : passwordHash,
      platformRole: opts.platformAdmin ? 'PLATFORM_ADMIN' : 'NONE', mustChangePassword: opts.mustChangePassword ?? false,
    },
  });
}

/** One configured clinic: Mon–Fri 09:00–18:00 with lunch break, one service, one doctor with schedule and eligibility. */
export async function makeClinic(slug: string, timezone: string, status: 'ACTIVE' | 'PENDING_SETUP' = 'ACTIVE') {
  const clinic = await prisma.clinic.create({
    data: { slug, name: `Fictional ${slug}`, timezone, defaultPhoneRegion: timezone === 'Asia/Bangkok' ? 'TH' : 'GB', status, activatedAt: status === 'ACTIVE' ? clock.now() : null },
  });
  for (let wd = 1; wd <= 5; wd++) {
    await prisma.clinicBusinessHour.createMany({ data: [{ clinicId: clinic.id, weekday: wd, startMin: 540, endMin: 720 }, { clinicId: clinic.id, weekday: wd, startMin: 780, endMin: 1080 }] });
  }
  const service = await prisma.clinicService.create({ data: { clinicId: clinic.id, name: 'General consultation', durationMin: 15, onlineBookingEnabled: true, walkInEnabled: true } });
  const doctor = await prisma.doctor.create({ data: { clinicId: clinic.id, displayName: 'Dr. Fictional Unlinked', titleLabel: 'General Practitioner' } });
  await prisma.doctorAvailability.create({ data: { clinicId: clinic.id, doctorId: doctor.id, weekday: 1, startMin: 540, endMin: 1020 } });
  await prisma.doctorService.create({ data: { clinicId: clinic.id, doctorId: doctor.id, serviceId: service.id } });
  const closure = await prisma.clinicClosure.create({ data: { clinicId: clinic.id, startDate: new Date('2026-12-25T00:00:00Z'), endDate: new Date('2026-12-25T00:00:00Z'), label: 'Holiday' } });
  const exception = await prisma.scheduleException.create({ data: { clinicId: clinic.id, doctorId: doctor.id, exceptionDate: new Date('2026-11-09T00:00:00Z'), kind: 'UNAVAILABLE' } });
  return { clinic, service, doctor, closure, exception };
}

export async function addMember(clinicId: string, userId: string, roles: ('CLINIC_ADMIN' | 'RECEPTIONIST' | 'DOCTOR')[], linkDoctorName?: string) {
  const member = await prisma.clinicMember.create({ data: { clinicId, userId, roles } });
  const doctor = linkDoctorName ? await prisma.doctor.create({ data: { clinicId, displayName: linkDoctorName, memberId: member.id } }) : null;
  return { member, doctor };
}

/**
 * SC1-BE-12 harness: clinic A (Asia/Bangkok) and clinic B (Europe/London), with a dual-membership user U who is
 * RECEPTIONIST in A and DOCTOR (linked profile) in B. All people and data are fictional.
 */
export async function makeWorld() {
  const pa = await makeUser('platform.admin@example.test', { platformAdmin: true });
  const A = await makeClinic('clinic-a', 'Asia/Bangkok');
  const B = await makeClinic('clinic-b', 'Europe/London');
  const adminA = await makeUser('admin.a@example.test');
  const adminB = await makeUser('admin.b@example.test');
  const recA = await makeUser('reception.a@example.test');
  const docA = await makeUser('doctor.a@example.test');
  const dual = await makeUser('dual.user@example.test');
  const mAdminA = await addMember(A.clinic.id, adminA.id, ['CLINIC_ADMIN']);
  await addMember(B.clinic.id, adminB.id, ['CLINIC_ADMIN']);
  const mRecA = await addMember(A.clinic.id, recA.id, ['RECEPTIONIST']);
  const mDocA = await addMember(A.clinic.id, docA.id, ['DOCTOR'], 'Dr. Fictional A');
  const mDualA = await addMember(A.clinic.id, dual.id, ['RECEPTIONIST']);
  const mDualB = await addMember(B.clinic.id, dual.id, ['DOCTOR'], 'Dr. Fictional Dual B');
  return { pa, A, B, adminA, adminB, recA, docA, dual, mAdminA, mRecA, mDocA, mDualA, mDualB };
}
export type World = Awaited<ReturnType<typeof makeWorld>>;
