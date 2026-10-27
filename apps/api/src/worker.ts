// Separate worker process (ADR-013): hold-expiry sweep (60 s), day close (5 min), event and idempotency purges (hourly).
// Staff notification jobs (SCHEDULE_CONFLICTS_DETECTED, DOCTOR_UNAVAILABLE_REASSIGN, ADR-014) are deferred.
import { loadEnv } from '@sc/config';
import { PrismaClient } from './generated/prisma/index.js';
import { createLogger } from './infra/logger';
import { systemClock } from './infra/clock';
import { expireHolds, purgeIdempotency } from './modules/booking/index';
import { closeDays } from './modules/queue/index';

const env = loadEnv();
const log = createLogger(env.LOG_LEVEL);
// Runs only where explicitly enabled (Docker Compose sets WORKER_ENABLED=true); never against a *_test database.
const dbName = new URL(env.DATABASE_URL).pathname.slice(1);
if (process.env.WORKER_ENABLED !== 'true' || env.NODE_ENV === 'test' || dbName.endsWith('_test')) {
  log.error({ dbName }, 'Worker disabled: set WORKER_ENABLED=true and use a non-test database');
  process.exit(1);
}
const prisma = new PrismaClient();

function every(ms: number, name: string, job: () => Promise<unknown>) {
  const run = () => job().then((r) => log.debug({ job: name, r }, 'job done')).catch((err) => log.error({ err, job: name }, 'job failed'));
  void run();
  return setInterval(run, ms);
}
every(60_000, 'expire-holds', () => expireHolds(prisma, systemClock.now()));
every(300_000, 'day-close', () => closeDays(prisma, systemClock.now())); // FR-QUE-016: within 5 min after local midnight
every(3_600_000, 'purge-events', () => prisma.clinicEvent.deleteMany({ where: { createdAt: { lt: new Date(systemClock.now().getTime() - 86_400_000) } } }));
every(3_600_000, 'purge-idempotency', () => purgeIdempotency(prisma, systemClock.now()));
log.info('Smart Clinic worker started');
