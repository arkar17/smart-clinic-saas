import { loadEnv } from '@sc/config';
import { PrismaClient } from './generated/prisma/index.js';
import { createApp } from './app';
import { systemClock } from './infra/clock';
import { createLogger } from './infra/logger';

const env = loadEnv();
const log = createLogger(env.LOG_LEVEL);
const prisma = new PrismaClient();
const app = createApp({ prisma, clock: systemClock, env, log });
void (app.locals.hub as import('./modules/realtime/index').Hub).start(env.DATABASE_URL).then(() => log.info('LISTEN connected'));
app.listen(env.PORT, () => log.info({ port: env.PORT }, 'Smart Clinic API listening'));
