// Opt-in fictional demo dataset (FR-DEM-001/002, SC5-BE-03). NEVER runs automatically and is not run by CI or tests.
// Usage (only after explicit Product Owner approval):
//   DEMO_SEED_CONFIRM=yes pnpm --filter @sc/api demo:seed -- --confirm
// Guards: both confirmations, a database named *_dev or *_demo (never *_test), and an empty clinic table.
// Reset (FR-DEM-003): `docker compose down -v && docker compose up -d db && docker compose run --rm migrate`, then seed again.
import { DateTime } from 'luxon';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { hashPassword } from '../src/modules/identity/index';

const DEMO_PASSWORD = 'Demo-Fictional-2026!'; // shared fictional demo password (local demo only)
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

async function main() {
  const name = new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname.slice(1);
  if (process.env.DEMO_SEED_CONFIRM !== 'yes' || !process.argv.includes('--confirm')) throw new Error('Refusing: set DEMO_SEED_CONFIRM=yes and pass --confirm');
  if (!/_(dev|demo)$/.test(name)) throw new Error(`Refusing: database "${name}" must end in _dev or _demo`);
  const prisma = new PrismaClient();
  try {
    if (await prisma.clinic.count()) throw new Error('Refusing: database already has clinics (reset it first)');
    const hash = await hashPassword(DEMO_PASSWORD);
    const user = (email: string, displayName: string, platform = false) =>
      prisma.user.create({ data: { email, displayName, passwordHash: hash, mustChangePassword: false, platformRole: platform ? 'PLATFORM_ADMIN' : 'NONE' } });
    await user('platform.admin@demo.example', 'Demo Platform Admin', true);
    const dual = await user('dual.doctor@demo.example', 'Dr. Demo Dual'); // one account, doctor in both clinics

    const clinics = [
      { slug: 'sunrise-demo', name: 'Sunrise Demo Clinic', timezone: 'Asia/Bangkok', region: 'TH', phone: (i: number) => `+6681000${String(1000 + i)}` },
      // Ofcom drama range: reserved for fiction (stored directly; not used for new public bookings).
      { slug: 'riverside-demo', name: 'Riverside Demo Clinic', timezone: 'Europe/London', region: 'GB', phone: (i: number) => `+447700900${String(100 + (i % 900))}` },
    ];
    for (const [ci, def] of clinics.entries()) {
      const clinic = await prisma.clinic.create({
        data: {
          slug: def.slug, name: def.name, timezone: def.timezone, defaultPhoneRegion: def.region, status: 'ACTIVE', activatedAt: new Date(),
          address: '1 Fictional Street', contactPhoneE164: def.phone(0), walkinEnabled: true, walkinDailyCapacity: 40,
        },
      });
      const short = def.name.split(' ')[0]!;
      const tag = def.slug.split('-')[0]!;
      const admin = await user(`admin.${tag}@demo.example`, `Demo Admin ${short}`);
      const rec = await user(`reception.${tag}@demo.example`, `Demo Reception ${short}`);
      const doc = await user(`doctor.${tag}@demo.example`, `Dr. Demo ${short}`);
      await prisma.clinicMember.create({ data: { clinicId: clinic.id, userId: admin.id, roles: ['CLINIC_ADMIN'] } });
      await prisma.clinicMember.create({ data: { clinicId: clinic.id, userId: rec.id, roles: ['RECEPTIONIST'] } });
      const docMember = await prisma.clinicMember.create({ data: { clinicId: clinic.id, userId: doc.id, roles: ['DOCTOR'] } });
      const dualMember = await prisma.clinicMember.create({ data: { clinicId: clinic.id, userId: dual.id, roles: ['DOCTOR'] } });
      for (let wd = 1; wd <= 6; wd++) {
        await prisma.clinicBusinessHour.createMany({
          data: wd === 6
            ? [{ clinicId: clinic.id, weekday: wd, startMin: 540, endMin: 780 }]
            : [{ clinicId: clinic.id, weekday: wd, startMin: 540, endMin: 720 }, { clinicId: clinic.id, weekday: wd, startMin: 780, endMin: 1080 }],
        });
      }
      const services = await Promise.all([
        prisma.clinicService.create({ data: { clinicId: clinic.id, name: 'General consultation', durationMin: 15, onlineBookingEnabled: true, walkInEnabled: true, displayOrder: 1 } }),
        prisma.clinicService.create({ data: { clinicId: clinic.id, name: 'Follow-up visit', durationMin: 10, onlineBookingEnabled: true, walkInEnabled: false, displayOrder: 2 } }),
      ]);
      const doctors = await Promise.all([
        prisma.doctor.create({ data: { clinicId: clinic.id, displayName: `Dr. Demo ${short}`, titleLabel: 'General Practitioner', memberId: docMember.id } }),
        prisma.doctor.create({ data: { clinicId: clinic.id, displayName: 'Dr. Demo Dual', titleLabel: 'General Practitioner', memberId: dualMember.id } }),
      ]);
      for (const d of doctors) {
        for (let wd = 1; wd <= 5; wd++) await prisma.doctorAvailability.create({ data: { clinicId: clinic.id, doctorId: d.id, weekday: wd, startMin: 540, endMin: 1020 } });
        for (const s of services) await prisma.doctorService.create({ data: { clinicId: clinic.id, doctorId: d.id, serviceId: s.id } });
      }
      const today = DateTime.now().setZone(def.timezone).startOf('day');
      const holiday = new Date(`${today.plus({ days: 21 }).toISODate()}T00:00:00Z`);
      await prisma.clinicClosure.create({ data: { clinicId: clinic.id, startDate: holiday, endDate: holiday, label: 'Fictional public holiday' } });

      // Two weeks of fictional history on past weekdays: completed appointments, walk-ins and one appointment no-show per day.
      let n = 0;
      for (let back = 14; back >= 1; back--) {
        const day = today.minus({ days: back });
        if (day.weekday > 5) continue;
        const date = new Date(`${day.toISODate()}T00:00:00Z`);
        await prisma.queueCounter.create({ data: { clinicId: clinic.id, serviceDate: date } });
        let token = 0;
        for (let k = 0; k < 6; k++) {
          n++;
          const letter = String.fromCharCode(65 + ci);
          const patient = await prisma.patient.create({
            data: { clinicId: clinic.id, fullName: `Demo Patient ${letter}${n}`, nameNormalized: `demo patient ${letter.toLowerCase()}${n}`, phoneE164: def.phone(n), source: k % 2 ? 'QR_WALK_IN' : 'QR_BOOKING' },
          });
          const start = day.set({ hour: 9 + k, minute: 0 }).toJSDate();
          const doctor = doctors[k % 2]!;
          const service = services[0]!;
          let appointmentId: string | null = null;
          if (k % 2 === 0) {
            const noShow = k === 4;
            const a = await prisma.appointment.create({
              data: {
                clinicId: clinic.id, doctorId: doctor.id, serviceId: service.id, patientId: patient.id, channel: 'PUBLIC', status: noShow ? 'NO_SHOW' : 'COMPLETED',
                serviceDate: date, startAt: start, endAt: new Date(start.getTime() + 15 * 60_000),
                bookingReference: `SC-${Array.from({ length: 8 }, () => CROCKFORD[Math.floor(Math.random() * 32)]).join('')}`,
                confirmedAt: start, checkedInAt: noShow ? null : start, completedAt: noShow ? null : start, noShowAt: noShow ? start : null,
              },
            });
            if (noShow) continue;
            appointmentId = a.id;
          }
          token++;
          const called = new Date(start.getTime() + (5 + k * 3) * 60_000);
          const done = new Date(called.getTime() + 12 * 60_000);
          await prisma.queueEntry.create({
            data: {
              clinicId: clinic.id, serviceDate: date, tokenNumber: token, doctorId: doctor.id, serviceId: service.id, patientId: patient.id, appointmentId,
              source: appointmentId ? 'SCHEDULED' : 'QR_WALK_IN', status: 'COMPLETED', countsTowardCapacity: !appointmentId,
              registeredAt: start, arrivedAt: start, sortTime: start, firstCalledAt: called, lastCalledAt: called, startedAt: called, completedAt: done, endedAt: done,
            },
          });
        }
        await prisma.queueCounter.update({ where: { clinicId_serviceDate: { clinicId: clinic.id, serviceDate: date } }, data: { lastToken: token, walkInCount: 3 } });
      }
      console.log(`Seeded ${def.name} (/c/${def.slug}) with ${n} fictional history visits.`);
    }
    console.log(`Done. Demo accounts (*@demo.example) use the fictional password ${DEMO_PASSWORD}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
